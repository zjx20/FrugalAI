import { Hono, Context, Next } from 'hono';
import { OAuth2Client } from 'google-auth-library';
import { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import { ApiKey, PrismaClient, Provider, User } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './db';
import userApp from './user';
import {
	convertChatCompletionCreateToGemini,
	convertGoogleResponseToOpenAi,
	GoogleToOpenAiSseTransformer,
} from './openai-adapter';

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const GEMINI_CODE_ASSIST_PROVIDER = 'gemini-code-assist';

export interface Env {
	KV: KVNamespace;
	DB: D1Database;
}

type AppVariables = {
	db: Database;
	user: User & {keys: (ApiKey & {provider: Provider})[]};
};

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Setup DB middleware
app.use('*', async (c, next) => {
	const adapter = new PrismaD1(c.env.DB);
	const prisma = new PrismaClient({ adapter });
	c.set('db', new Database(prisma));
	await next();
});

// --- User Management API ---
app.route('/api', userApp);


// --- Core Proxy Logic ---

// Auth middleware for proxy endpoints
const proxyAuth = async (c: Context<{ Bindings: Env; Variables: AppVariables }>, next: Next) => {
	let token: string | undefined;

	// 1. Check for Authorization header (Bearer token)
	const authHeader = c.req.header('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		token = authHeader.substring(7);
	}

	// 2. Check for x-goog-api-key header
	if (!token) {
		token = c.req.header('x-goog-api-key');
	}

	// 3. Check for key query parameter
	if (!token) {
		token = c.req.query('key');
	}

	if (!token) {
		return c.json({ error: 'Unauthorized: No API key provided.' }, 401);
	}

	const db = c.get('db');
	const user = await db.findUserByToken(token);

	if (!user) {
		return c.json({ error: 'Unauthorized: Invalid API key.' }, 401);
	}

	c.set('user', user);
	await next();
};

app.use('/v1/*', proxyAuth);
app.use('/v1beta/*', proxyAuth);


/**
 * Intelligently parses the keyData from an ApiKey.
 * It supports both legacy Base64 encoded JSON and native JSON objects.
 * @param keyData The keyData from the ApiKey model.
 * @returns The parsed credentials object with tokens and projectId.
 */
function parseKeyData(keyData: any): { tokens: any; projectId: string } {
	if (typeof keyData === 'object' && keyData !== null) {
		// Handle {"key": "<base64 string>"} format
		if (typeof keyData.key === 'string') {
			try {
				const decodedString = Buffer.from(keyData.key, 'base64').toString('utf-8');
				return JSON.parse(decodedString);
			} catch (e) {
				throw new Error('Failed to parse base64 encoded key from keyData.key');
			}
		}
		// Handle direct JSON object format
		return keyData as { tokens: any; projectId: string };
	} else if (typeof keyData === 'string') {
		// Legacy support for plain base64 string
		try {
			const decodedString = Buffer.from(keyData, 'base64').toString('utf-8');
			return JSON.parse(decodedString);
		} catch (e) {
			// Legacy support for plain JSON string
			try {
				return JSON.parse(keyData);
			} catch (e2) {
				throw new Error('Failed to parse keyData from both Base64 and plain JSON string.');
			}
		}
	}
	throw new Error('Unsupported keyData format.');
}


// Helper function to forward requests to the Google API
async function forwardRequest(c: any, apiKey: any, model: string, method: string, requestBodyOverride?: any, sse?: boolean) {
	const db: Database = c.get('db');
	const { tokens, projectId } = parseKeyData(apiKey.keyData);

	const client = new OAuth2Client({
		clientId: OAUTH_CLIENT_ID,
		clientSecret: OAUTH_CLIENT_SECRET,
	});
	client.setCredentials(tokens);

	try {
		await client.getAccessToken(); // Refreshes the token if needed
	} catch (e: any) {
		if (e.response?.data?.error === 'invalid_grant') {
			console.error(`Permanent failure for ApiKey ${apiKey.id} (invalid_grant): ${e.message}`);
			await db.updateApiKey(apiKey.id, { permanentlyFailed: true });
			return { permanentlyFailed: true };
		}
		// For other errors during token refresh, re-throw them to be handled as temporary failures
		throw e;
	}

	const refreshedCredentials = client.credentials;
	if (refreshedCredentials.access_token !== tokens.access_token) {
		// Persist the refreshed tokens
		const newKeyData = {
			tokens: {
				refresh_token: refreshedCredentials.refresh_token,
				expiry_date: refreshedCredentials.expiry_date,
				access_token: refreshedCredentials.access_token,
				token_type: refreshedCredentials.token_type,
				id_token: refreshedCredentials.id_token,
				scope: refreshedCredentials.scope,
			},
			projectId,
		};
		c.executionCtx.waitUntil(db.updateApiKey(apiKey.id, { keyData: newKeyData as any }));
	}

	const version = process.env.CLI_VERSION || process.version;
	const userAgent = `GeminiCLI/${version} (${process.platform}; ${process.arch})`;

	const requestBody = requestBodyOverride ?? await c.req.json();
	const body = {
		model: model,
		project: projectId,
		request: requestBody,
	};

	const headers = new Headers();
	headers.append('Content-Type', 'application/json');
	headers.append('User-Agent', userAgent);
	headers.append('Authorization', `Bearer ${refreshedCredentials.access_token}`);

	const url = new URL(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`);
	if (sse) {
		url.searchParams.set('alt', 'sse');
	}

	const upstreamResponse = await fetch(url, {
		method: c.req.method,
		headers: headers,
		body: JSON.stringify(body),
	});

	return { response: upstreamResponse, permanentlyFailed: false };
}

// Helper function to process the response from Google API for OpenAI compatibility
async function processUpstreamResponseOpenAI(c: any, upstreamResponse: Response, model: string, stream: boolean, includeUsage: boolean) {
	if (!upstreamResponse.ok) {
		return upstreamResponse; // Pass through error responses directly.
	}

	if (stream) {
		if (!upstreamResponse.body) {
			return new Response('Upstream response has no body', { status: 500 });
		}
		const unwrapStream = new TransformStream(new CodeAssistUnwrapTransformer());
		const openAiTransformStream = new TransformStream(new GoogleToOpenAiSseTransformer(model, includeUsage));

		const transformedBody = upstreamResponse.body
			.pipeThrough(unwrapStream)
			.pipeThrough(openAiTransformStream);

		const responseHeaders = new Headers(upstreamResponse.headers);
		responseHeaders.set('Content-Type', 'text/event-stream');
		return new Response(transformedBody, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		});
	} else {
		let respObj: any = await upstreamResponse.json();
		// The Code Assist API wraps the actual response.
		if (respObj && typeof respObj === 'object' && respObj.response) {
			respObj = respObj.response;
		}
		const openAIResponse = convertGoogleResponseToOpenAi(respObj, model);
		return c.json(openAIResponse);
	}
}

function extractModel(model: string): string {
	const parts = model.split(':');
	if (parts.length === 2) {
		return parts[1];
	}
	return model;
}

app.post('/v1/chat/completions', async (c) => {
	const user = c.get('user');
	const db: Database = c.get('db');

	const openAIRequestBody: ChatCompletionCreateParams = await c.req.json();
	const model = extractModel(openAIRequestBody.model);
	const stream = openAIRequestBody.stream ?? false;
	const method = stream ? 'streamGenerateContent' : 'generateContent';
	const geminiRequestParams = convertChatCompletionCreateToGemini(openAIRequestBody);

	const {
		tools, toolConfig,
		safetySettings,
		systemInstruction,
		cachedContent,
		httpOptions: _httpOptions,  // Drop this field from generateConfig
		abortSignal: _abortSignal,  // Drop this field from generateConfig
		...generateConfig
	} = geminiRequestParams.config || {};

	const requestBody = {
		contents: geminiRequestParams.contents,
		tools: tools,
		toolConfig: toolConfig,
		safetySettings: safetySettings,
		systemInstruction: systemInstruction,
		generationConfig: generateConfig,
		cachedContent: cachedContent,
	};

	try {
		const now = Date.now();
		const availableKeys = user.keys.filter((key: any) =>
			key.providerName === GEMINI_CODE_ASSIST_PROVIDER &&
			!key.permanentlyFailed &&
			(!key.throttleData || (key.throttleData as any).expiration <= now)
		);

		if (availableKeys.length === 0) {
			const permanentlyFailedKeys = user.keys
				.filter((k: any) => k.permanentlyFailed)
				.map((k: any) => k.id);
			let error = 'All available API keys for this provider are currently rate-limited.';
			if (permanentlyFailedKeys.length > 0) {
				error += ` The following keys have permanently failed and need to be replaced: ${permanentlyFailedKeys.join(', ')}.`;
			}
			return c.json({ error }, 429);
		}

		for (const key of availableKeys) {
			const result = await forwardRequest(c, key, model, method, requestBody, stream);

			if (result.permanentlyFailed) {
				continue; // Try next key
			}

			const { response } = result;

			if (response!.status === 429) {
				const provider = key.provider;
				const throttleDuration = (provider.maxThrottleDuration || 15) * 60 * 1000;
				console.log(`ApiKey ${key.id} was rate-limited. Throttling for ${throttleDuration / 1000}s.`);
				const throttleData = { expiration: Date.now() + throttleDuration };
				c.executionCtx.waitUntil(db.updateApiKeyThrottleData(key.id, throttleData));
				continue; // Try next key
			}

			const includeUsage = openAIRequestBody.stream_options?.include_usage ?? false;
			return processUpstreamResponseOpenAI(c, response!, model, stream, includeUsage);
		}

		// If all keys were tried and failed
		return c.json({ error: 'All available API keys failed or were rate-limited.' }, 500);

	} catch (e: any) {
		console.error('Error processing request:', e);
		if (e.response && e.response.status) {
			return c.json({ error: 'Google API error', details: e.response.data }, e.response.status);
		} else {
			return c.json({ error: 'Failed to forward request', details: e.message }, 500);
		}
	}
});

// Helper function to process the response from Google API
async function processUpstreamResponseGemini(c: any, upstreamResponse: Response) {
	if (!upstreamResponse.ok) {
		return upstreamResponse; // Pass through error responses directly.
	}

	const sse = c.req.query('alt') === 'sse';

	if (sse) {
		if (!upstreamResponse.body) {
			return new Response('Upstream response has no body', { status: 500 });
		}
		const transformStream = new TransformStream(new CodeAssistUnwrapTransformer());
		const transformedBody = upstreamResponse.body.pipeThrough(transformStream);
		const responseHeaders = new Headers(upstreamResponse.headers);
		responseHeaders.set('Content-Type', 'text/event-stream');
		return new Response(transformedBody, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		});
	} else {
		let respObj: any = await upstreamResponse.json();
		if (Array.isArray(respObj)) {
			const unwrapped = [];
			for (const obj of respObj) {
				if (obj && obj.response) {
					unwrapped.push(obj.response);
				}
			}
			respObj = unwrapped;
		} else if (respObj && typeof respObj === 'object' && respObj.response) {
			respObj = respObj.response;
		}
		return c.json(respObj);
	}
}

app.post('/v1beta/models/:modelAndMethod{[a-zA-Z0-9.-]+:[a-zA-Z]+}', async (c) => {
	const user = c.get('user');
	const db: Database = c.get('db');
	const modelAndMethod = c.req.param('modelAndMethod');
	const [model, method] = modelAndMethod.split(':');
	const sse = c.req.query('alt') === 'sse';

	try {
		const now = Date.now();
		const availableKeys = user.keys.filter((key: any) =>
			key.providerName === GEMINI_CODE_ASSIST_PROVIDER &&
			!key.permanentlyFailed &&
			(!key.throttleData || (key.throttleData as any).expiration <= now)
		);

		if (availableKeys.length === 0) {
			return c.json({ error: 'All available API keys for this provider are currently rate-limited or have permanently failed.' }, 429);
		}

		for (const key of availableKeys) {
			const result = await forwardRequest(c, key, model, method, undefined, sse);

			if (result.permanentlyFailed) {
				continue; // Try next key
			}

			const { response } = result;

			if (response!.status === 429) {
				const provider = key.provider;
				const throttleDuration = (provider.maxThrottleDuration || 15) * 60 * 1000;
				console.log(`ApiKey ${key.id} was rate-limited. Throttling for ${throttleDuration / 1000}s.`);
				const throttleData = { expiration: Date.now() + throttleDuration };
				c.executionCtx.waitUntil(db.updateApiKeyThrottleData(key.id, throttleData));
				continue; // Try next key
			}

			return processUpstreamResponseGemini(c, response!);
		}

		return c.json({ error: 'All available API keys failed or were rate-limited.' }, 500);

	} catch (e: any) {
		console.error('Error processing request:', e);
		if (e.response && e.response.status) {
			return c.json({ error: 'Google API error', details: e.response.data }, e.response.status);
		} else {
			return c.json({ error: 'Failed to forward request', details: e.message }, 500);
		}
	}
});

/**
 * A TransformStream that intercepts Server-Sent Events (SSE) from the
 * Google Code Assist API and unwraps the nested `response` object to match
 * the standard Gemini API format.
 */
class CodeAssistUnwrapTransformer implements Transformer<Uint8Array, Uint8Array> {
	private buffer = '';
	private decoder = new TextDecoder();
	private encoder = new TextEncoder();

	transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
		this.buffer += this.decoder.decode(chunk, { stream: true });

		const outputs = [];
		let pos = 0;
		while (true) {
			if (pos == this.buffer.length) {
				this.buffer = '';
				break;
			}
			let index = this.buffer.indexOf('\n', pos);
			if (index == -1) {
				this.buffer = this.buffer.slice(pos);
				break;
			}
			const line = this.buffer.slice(pos, index + 1);
			pos = index + 1;
			if (!line.startsWith('data:')) {
				outputs.push(line);
				continue;
			}

			const dataJson = line.substring(5).trim();
			if (dataJson === '[DONE]') {
				outputs.push(line);
				continue;
			}
			try {
				const dataObj = JSON.parse(dataJson);
				if (dataObj.response) {
					let endl = '\n';
					if (line.endsWith('\r\n')) {
						endl = '\r\n';
					}
					const unwrappedData = dataObj.response;
					outputs.push(`data: ${JSON.stringify(unwrappedData)}${endl}`);
				} else {
					outputs.push(line);
				}
			} catch (e) {
				console.error('SSE data is not valid JSON, passing through:', dataJson);
				outputs.push(line);
			}
		}
		if (outputs) {
			controller.enqueue(this.encoder.encode(outputs.join('')));
		}
	}

	flush(controller: TransformStreamDefaultController<Uint8Array>) {
		if (this.buffer) {
			console.error('[CodeAssistUnwrapTransformer] Unprocessed buffer remaining at the end of the stream:', this.buffer);
			controller.enqueue(this.encoder.encode(this.buffer));
		}
	}
}

export default app;

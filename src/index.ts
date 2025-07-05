import { Hono } from 'hono';
import { OAuth2Client } from 'google-auth-library';
import { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import {
	convertChatCompletionCreateToGemini,
	convertGoogleResponseToOpenAi,
	GoogleToOpenAiSseTransformer,
} from './openai-adapter';

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';

const THROTTLE_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const FLEET_KEY_PREFIX = 'fleet-';

export interface Env {
	KV: KVNamespace;
}

// Define interfaces for better type safety
interface UserData {
	credentials: any; // OAuth2ClientCredentials
	apiKey: string;
	projectId: string;
	permanentlyFailed?: boolean;
}

interface FleetMember {
	userId: string;
	credentials: any; // OAuth2ClientCredentials
	projectId: string;
	permanentlyFailed?: boolean;
}

interface FleetData {
	members: FleetMember[];
	throttled: { [userId: string]: number }; // userId -> throttle expiration timestamp
}

const app = new Hono<{ Bindings: Env }>();

app.post('/register', async (c) => {
	try {
		const { credentials: encodedCredentials } = await c.req.json();
		if (!encodedCredentials) {
			return c.json({ error: 'Encoded credentials are required.' }, 400);
		}

		const credentialsDataString = Buffer.from(encodedCredentials, 'base64').toString('utf-8');
		const { tokens, projectId } = JSON.parse(credentialsDataString);

		if (!projectId) {
			return c.json({ error: 'Project ID is missing from credentials data.' }, 400);
		}

		const client = new OAuth2Client();
		client.setCredentials(tokens);

		const tokenInfo = await client.getTokenInfo(tokens.access_token);
		const userId = tokenInfo.sub;

		if (!userId) {
			throw new Error('Could not retrieve user ID from token.');
		}

		const existingUserData = await c.env.KV.get(userId);
		if (existingUserData) {
			const { apiKey: oldApiKey } = JSON.parse(existingUserData);
			if (oldApiKey) {
				await c.env.KV.delete(`apikey:${oldApiKey}`);
			}
		}

		const newApiKey = crypto.randomUUID();
		const userData = {
			credentials: tokens,
			apiKey: newApiKey,
			projectId: projectId,
		};

		await Promise.all([
			c.env.KV.put(userId, JSON.stringify(userData)),
			c.env.KV.put(`apikey:${newApiKey}`, userId)
		]);

		return c.json({ apiKey: newApiKey });

	} catch (e: any) {
		console.error(e);
		return c.json({ error: 'Registration failed.', details: e.message }, 500);
	}
});

app.post('/revoke', async (c) => {
	const authHeader = c.req.header('Authorization');
	const apiKey = authHeader?.split(' ')[1]; // Expecting "Bearer <key>"

	if (!apiKey) {
		return c.json({ error: 'API key is missing from Authorization header' }, 401);
	}

	// Check if it's a fleet key
	if (apiKey.startsWith(FLEET_KEY_PREFIX)) {
		const fleetDataString = await c.env.KV.get(`fleet:${apiKey}`);
		if (!fleetDataString) {
			return c.json({ error: 'Invalid Fleet API key' }, 401);
		}
		const fleetData: FleetData = JSON.parse(fleetDataString);

		try {
			const revokePromises = fleetData.members.map(async (member) => {
				const client = new OAuth2Client({
					clientId: OAUTH_CLIENT_ID,
					clientSecret: OAUTH_CLIENT_SECRET,
				});
				client.setCredentials(member.credentials);

				if (member.credentials.refresh_token) {
					await client.revokeToken(member.credentials.refresh_token);
				} else if (member.credentials.access_token) {
					await client.revokeToken(member.credentials.access_token);
				}
			});
			await Promise.all(revokePromises);

			await c.env.KV.delete(`fleet:${apiKey}`);
			return c.json({ message: 'Fleet authorization revoked successfully.' });

		} catch (e: any) {
			console.error('Fleet revocation failed:', e);
			// Even if revocation fails, delete KV entries to prevent invalid keys from lingering
			await c.env.KV.delete(`fleet:${apiKey}`);
			return c.json({ error: 'Fleet revocation failed.', details: e.message }, 500);
		}
	} else {
		// Existing individual API key revocation logic
		const userId = await c.env.KV.get(`apikey:${apiKey}`);
		if (!userId) {
			return c.json({ error: 'Invalid API key' }, 401);
		}

		const userDataString = await c.env.KV.get(userId);
		if (!userDataString) {
			await c.env.KV.delete(`apikey:${apiKey}`);
			return c.json({ error: 'Invalid API key, user data not found' }, 401);
		}

		try {
			const { credentials } = JSON.parse(userDataString);
			const client = new OAuth2Client({
				clientId: OAUTH_CLIENT_ID,
				clientSecret: OAUTH_CLIENT_SECRET,
			});
			client.setCredentials(credentials);

			if (credentials.refresh_token) {
				await client.revokeToken(credentials.refresh_token);
			} else if (credentials.access_token) {
				await client.revokeToken(credentials.access_token);
			}

			await Promise.all([
				c.env.KV.delete(userId),
				c.env.KV.delete(`apikey:${apiKey}`)
			]);

			return c.json({ message: 'Authorization revoked successfully.' });

		} catch (e: any) {
			console.error('Revocation failed:', e);
			await Promise.all([
				c.env.KV.delete(userId),
				c.env.KV.delete(`apikey:${apiKey}`)
			]);
			return c.json({ error: 'Revocation failed.', details: e.message }, 500);
		}
	}
});

// Helper function to process credentials and get userId, credentials, projectId
async function processCredentials(encodedCredentials: string): Promise<{ userId: string, credentials: any, projectId: string }> {
	const credentialsDataString = Buffer.from(encodedCredentials, 'base64').toString('utf-8');
	const { tokens, projectId } = JSON.parse(credentialsDataString);

	if (!projectId) {
		throw new Error('Project ID is missing from credentials data.');
	}

	const client = new OAuth2Client();
	client.setCredentials(tokens);

	const tokenInfo = await client.getTokenInfo(tokens.access_token);
	const userId = tokenInfo.sub;

	if (!userId) {
		throw new Error('Could not retrieve user ID from token.');
	}
	return { userId, credentials: tokens, projectId };
}

app.post('/fleet/register', async (c) => {
	try {
		const { credentials: encodedCredentials } = await c.req.json();
		if (!encodedCredentials) {
			return c.json({ error: 'Credentials are required.' }, 400);
		}

		const newFleetApiKey = FLEET_KEY_PREFIX + crypto.randomUUID();
		const members: FleetMember[] = [];
		const throttled: { [userId: string]: number } = {};

		// Process captain credentials
		const captainInfo = await processCredentials(encodedCredentials);
		members.push({
			userId: captainInfo.userId,
			credentials: captainInfo.credentials,
			projectId: captainInfo.projectId,
		});

		const fleetData: FleetData = { members, throttled };

		await c.env.KV.put(`fleet:${newFleetApiKey}`, JSON.stringify(fleetData));

		return c.json({ fleetApiKey: newFleetApiKey });

	} catch (e: any) {
		console.error(e);
		return c.json({ error: 'Fleet registration failed.', details: e.message }, 500);
	}
});

app.post('/fleet/add', async (c) => {
	try {
		const authHeader = c.req.header('Authorization');
		const fleetApiKey = authHeader?.split(' ')[1];

		if (!fleetApiKey || !fleetApiKey.startsWith(FLEET_KEY_PREFIX)) {
			return c.json({ error: 'Valid Fleet API key is required in Authorization header.' }, 401);
		}

		const { credentials: encodedNewMemberCredentials } = await c.req.json();
		if (!encodedNewMemberCredentials) {
			return c.json({ error: 'Encoded credentials for new member are required.' }, 400);
		}

		const fleetDataString = await c.env.KV.get(`fleet:${fleetApiKey}`);
		if (!fleetDataString) {
			return c.json({ error: 'Fleet not found or invalid Fleet API key.' }, 404);
		}
		const fleetData: FleetData = JSON.parse(fleetDataString);

		const newMemberInfo = await processCredentials(encodedNewMemberCredentials);

		// Check if member already exists in the fleet
		if (fleetData.members.some(m => m.userId === newMemberInfo.userId)) {
			return c.json({ message: 'Member already exists in this fleet.' }, 200);
		}

		fleetData.members.push({
			userId: newMemberInfo.userId,
			credentials: newMemberInfo.credentials,
			projectId: newMemberInfo.projectId,
		});

		await c.env.KV.put(`fleet:${fleetApiKey}`, JSON.stringify(fleetData));

		return c.json({ message: 'Member added successfully.' });

	} catch (e: any) {
		console.error(e);
		return c.json({ error: 'Failed to add member to fleet.', details: e.message }, 500);
	}
});

app.post('/fleet/remove', async (c) => {
	try {
		const authHeader = c.req.header('Authorization');
		const fleetApiKey = authHeader?.split(' ')[1];

		if (!fleetApiKey || !fleetApiKey.startsWith(FLEET_KEY_PREFIX)) {
			return c.json({ error: 'Valid Fleet API key is required in Authorization header.' }, 401);
		}

		const { userId: memberUserIdToRemove } = await c.req.json();
		if (!memberUserIdToRemove) {
			return c.json({ error: 'Member userId to remove is required.' }, 400);
		}

		const fleetDataString = await c.env.KV.get(`fleet:${fleetApiKey}`);
		if (!fleetDataString) {
			return c.json({ error: 'Fleet not found or invalid Fleet API key.' }, 404);
		}
		let fleetData: FleetData = JSON.parse(fleetDataString);

		const memberToRemove = fleetData.members.find(m => m.userId === memberUserIdToRemove);
		if (!memberToRemove) {
			return c.json({ message: 'Member not found in this fleet.' }, 200);
		}

		// Revoke token for the member being removed
		try {
			const client = new OAuth2Client({
				clientId: OAUTH_CLIENT_ID,
				clientSecret: OAUTH_CLIENT_SECRET,
			});
			client.setCredentials(memberToRemove.credentials);

			if (memberToRemove.credentials.refresh_token) {
				await client.revokeToken(memberToRemove.credentials.refresh_token);
			} else if (memberToRemove.credentials.access_token) {
				await client.revokeToken(memberToRemove.credentials.access_token);
			}
			console.log(`Successfully revoked token for member ${memberUserIdToRemove}`);
		} catch (e: any) {
			console.error(`Failed to revoke token for member ${memberUserIdToRemove}:`, e);
			// Continue with removal even if token revocation fails
		}

		fleetData.members = fleetData.members.filter(m => m.userId !== memberUserIdToRemove);

		// Also remove from throttled list if present
		delete fleetData.throttled[memberUserIdToRemove];

		await c.env.KV.put(`fleet:${fleetApiKey}`, JSON.stringify(fleetData));

		return c.json({ message: 'Member removed successfully.' });

	} catch (e: any) {
		console.error(e);
		return c.json({ error: 'Failed to remove member from fleet.', details: e.message }, 500);
	}
});

/**
 * A TransformStream that intercepts Server-Sent Events (SSE) from the
 * Google Code Assist API and unwraps the nested response to match the
 * standard Gemini API format.
 *
 * The Code Assist API wraps each SSE data payload like this:
 * `data: {"response": {"candidates": [...]}}`
 *
 * This transformer extracts the inner `response` object, so the client receives:
 * `data: {"candidates": [...]}`
 *
 * Google's API server typically uses `\r\n\r\n` as the event delimiter.
 * It's important to retain this characteristic, otherwise some clients
 * may not be able to parse the events.
 */
class SseUnwrapTransformer implements Transformer<Uint8Array, Uint8Array> {
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
					// console.log('unwrappedData:', JSON.stringify(unwrappedData));
					outputs.push(`data: ${JSON.stringify(unwrappedData)}${endl}`);
				} else {
					// This might handle non-standard or error messages that are still valid JSON
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
			// Normally, the server adds a delimiter after the last event,
			// so there should be no unprocessed buffer at the end.
			console.error('[SseUnwrapTransformer] Unprocessed buffer remaining at the end of the stream:', this.buffer);
			controller.enqueue(this.encoder.encode(this.buffer));
		}
	}
}

// Helper function to forward requests to the Google API
async function forwardRequest(c: any, credentials: any, projectId: string, model: string, method: string, requestBodyOverride?: any, sse?: boolean) {
	const client = new OAuth2Client({
		clientId: OAUTH_CLIENT_ID,
		clientSecret: OAUTH_CLIENT_SECRET,
	});
	client.setCredentials(credentials);

	try {
		await client.getAccessToken(); // Refreshes the token if needed
	} catch (e: any) {
		if (e.response?.data?.error === 'invalid_grant') {
			console.error(`Permanent failure for a credential (invalid_grant): ${e.message}`);
			return { permanentlyFailed: true };
		}
		// For other errors during token refresh, re-throw them to be handled as temporary failures
		throw e;
	}

	const refreshedCredentials = client.credentials;

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

	return { response: upstreamResponse, refreshedCredentials, permanentlyFailed: false };
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
		const unwrapStream = new TransformStream(new SseUnwrapTransformer());
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
	const authHeader = c.req.header('Authorization');
	const apiKey = authHeader?.split(' ')[1]; // Expecting "Bearer <key>"

	if (!apiKey) {
		return c.json({ error: 'API key is missing from Authorization header' }, 401);
	}

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
		httpOptions: _httpOptions,
		abortSignal: _abortSignal,
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
		// Handle Fleet API Key
		if (apiKey.startsWith(FLEET_KEY_PREFIX)) {
			const fleetDataString = await c.env.KV.get(`fleet:${apiKey}`);
			if (!fleetDataString) {
				return c.json({ error: 'Invalid Fleet API key' }, 401);
			}
			let fleetData: FleetData = JSON.parse(fleetDataString);
			const now = Date.now();
			let kvNeedsUpdate = false;

			// Lazily update throttled members in memory
			const activeThrottled: { [userId: string]: number } = {};
			for (const userId in fleetData.throttled) {
				if (fleetData.throttled[userId] > now) {
					activeThrottled[userId] = fleetData.throttled[userId];
				}
			}
			fleetData.throttled = activeThrottled;

			const availableMembers = fleetData.members.filter(m =>
				!m.permanentlyFailed &&
				(!fleetData.throttled[m.userId] || fleetData.throttled[m.userId] <= now)
			);

			if (availableMembers.length === 0) {
				const permanentlyFailedUserIds = fleetData.members
					.filter(m => m.permanentlyFailed)
					.map(m => m.userId);
				let error = 'All fleet members are currently rate-limited.';
				if (permanentlyFailedUserIds.length > 0) {
					error += ` The following members have permanently failed and need re-authorization: ${permanentlyFailedUserIds.join(', ')}.`;
				}
				return c.json({ error }, 429);
			}

			for (const member of availableMembers) {
				const result = await forwardRequest(c, member.credentials, member.projectId, model, method, requestBody, stream);

				if (result.permanentlyFailed) {
					member.permanentlyFailed = true;
					kvNeedsUpdate = true;
					continue; // Try next member
				}

				const { response, refreshedCredentials } = result;

				if (refreshedCredentials && refreshedCredentials.access_token !== member.credentials.access_token) {
					member.credentials = refreshedCredentials;
					kvNeedsUpdate = true;
				}

				if (response!.status === 429) {
					console.log(`Member ${member.userId} was rate-limited. Throttling for ${THROTTLE_DURATION_MS / 1000}s.`);
					fleetData.throttled[member.userId] = Date.now() + THROTTLE_DURATION_MS;
					kvNeedsUpdate = true;
					continue; // Try next member
				}

				if (kvNeedsUpdate) {
					c.executionCtx.waitUntil(c.env.KV.put(`fleet:${apiKey}`, JSON.stringify(fleetData)));
				}
				const includeUsage = openAIRequestBody.stream_options?.include_usage ?? false;
				return processUpstreamResponseOpenAI(c, response!, model, stream, includeUsage);
			}

			if (kvNeedsUpdate) {
				await c.env.KV.put(`fleet:${apiKey}`, JSON.stringify(fleetData));
			}

			const permanentlyFailedUserIds = fleetData.members
				.filter(m => m.permanentlyFailed)
				.map(m => m.userId);
			let errorMessage = 'All available fleet members failed due to rate-limiting.';
			if (permanentlyFailedUserIds.length > 0) {
				errorMessage += ` The following members have permanently failed and need re-authorization: ${permanentlyFailedUserIds.join(', ')}.`;
			}
			return c.json({ error: errorMessage }, 429);

		} else {
			// Handle Individual API Key
			const userId = await c.env.KV.get(`apikey:${apiKey}`);
			if (!userId) {
				return c.json({ error: 'Invalid API key' }, 401);
			}

			const userDataString = await c.env.KV.get(userId);
			if (!userDataString) {
				return c.json({ error: 'Could not find credentials for user' }, 500);
			}
			let userData: UserData = JSON.parse(userDataString);

			if (userData.permanentlyFailed) {
				return c.json({ error: 'Your API key is no longer valid due to revoked Google authorization. Please register again.' }, 401);
			}

			const result = await forwardRequest(c, userData.credentials, userData.projectId, model, method, requestBody, stream);

			if (result.permanentlyFailed) {
				userData.permanentlyFailed = true;
				c.executionCtx.waitUntil(c.env.KV.put(userId, JSON.stringify(userData)));
				return c.json({ error: 'Your API key is no longer valid due to revoked Google authorization. Please register again.' }, 401);
			}

			const { response, refreshedCredentials } = result;

			if (refreshedCredentials && refreshedCredentials.access_token !== userData.credentials.access_token) {
				userData.credentials = refreshedCredentials;
				c.executionCtx.waitUntil(c.env.KV.put(userId, JSON.stringify(userData)));
			}
			const includeUsage = openAIRequestBody.stream_options?.include_usage ?? false;
			return processUpstreamResponseOpenAI(c, response!, model, stream, includeUsage);
		}
	} catch (e: any) {
		console.error('Error processing request:', e);
		if (e.response && e.response.status) {
			return c.json({ error: 'Google API error', details: e.response.data }, e.response.status);
		} else {
			return c.json({ error: 'Failed to forward request', details: e.message }, 500);
		}
	}
});

app.post('/v1beta/models/:modelAndMethod{[a-zA-Z0-9.-]+:[a-zA-Z]+}', async (c) => {
	const apiKey = c.req.query('key') || c.req.header('x-goog-api-key');
	if (!apiKey) {
		return c.json({ error: 'API key is missing' }, 401);
	}

	const modelAndMethod = c.req.param('modelAndMethod');
	const [model, method] = modelAndMethod.split(':');
	const sse = c.req.query('alt') === 'sse';
	console.log(`model: ${model}, method: ${method}, queries: ${JSON.stringify(c.req.queries())}, sse: ${sse}`);

	try {
		// Handle Fleet API Key
		if (apiKey.startsWith(FLEET_KEY_PREFIX)) {
			const fleetDataString = await c.env.KV.get(`fleet:${apiKey}`);
			if (!fleetDataString) {
				return c.json({ error: 'Invalid Fleet API key' }, 401);
			}
			let fleetData: FleetData = JSON.parse(fleetDataString);
			const now = Date.now();
			let kvNeedsUpdate = false;

			// Lazily update throttled members in memory
			const activeThrottled: { [userId: string]: number } = {};
			for (const userId in fleetData.throttled) {
				if (fleetData.throttled[userId] > now) {
					activeThrottled[userId] = fleetData.throttled[userId];
				}
			}
			// Only mark for KV update if something else changes.
			// This cleanup is lazy.
			fleetData.throttled = activeThrottled;

			const availableMembers = fleetData.members.filter(m =>
				!m.permanentlyFailed &&
				(!fleetData.throttled[m.userId] || fleetData.throttled[m.userId] <= now)
			);

			if (availableMembers.length === 0) {
				const permanentlyFailedUserIds = fleetData.members
					.filter(m => m.permanentlyFailed)
					.map(m => m.userId);
				let error = 'All fleet members are currently rate-limited.';
				if (permanentlyFailedUserIds.length > 0) {
					error += ` The following members have permanently failed and need re-authorization: ${permanentlyFailedUserIds.join(', ')}.`;
				}
				return c.json({ error }, 429);
			}

			for (const member of availableMembers) {
				const result = await forwardRequest(c, member.credentials, member.projectId, model, method, undefined, sse);

				if (result.permanentlyFailed) {
					member.permanentlyFailed = true;
					kvNeedsUpdate = true;
					continue; // Try next member
				}

				const { response, refreshedCredentials } = result;

				if (refreshedCredentials && refreshedCredentials.access_token !== member.credentials.access_token) {
					member.credentials = refreshedCredentials;
					kvNeedsUpdate = true;
				}

				if (response!.status === 429) {
					console.log(`Member ${member.userId} was rate-limited. Throttling for ${THROTTLE_DURATION_MS / 1000}s.`);
					fleetData.throttled[member.userId] = Date.now() + THROTTLE_DURATION_MS;
					kvNeedsUpdate = true;
					continue; // Try next member
				}

				if (kvNeedsUpdate) {
					c.executionCtx.waitUntil(c.env.KV.put(`fleet:${apiKey}`, JSON.stringify(fleetData)));
				}
				return processUpstreamResponse(c, response!);
			}

			// After the loop, if any state changed, persist it.
			if (kvNeedsUpdate) {
				await c.env.KV.put(`fleet:${apiKey}`, JSON.stringify(fleetData));
			}

			const permanentlyFailedUserIds = fleetData.members
				.filter(m => m.permanentlyFailed)
				.map(m => m.userId);
			let errorMessage = 'All available fleet members failed due to rate-limiting.';
			if (permanentlyFailedUserIds.length > 0) {
				errorMessage += ` The following members have permanently failed and need re-authorization: ${permanentlyFailedUserIds.join(', ')}.`;
			}
			return c.json({ error: errorMessage }, 429);

		} else {
			// Handle Individual API Key
			const userId = await c.env.KV.get(`apikey:${apiKey}`);
			if (!userId) {
				return c.json({ error: 'Invalid API key' }, 401);
			}

			const userDataString = await c.env.KV.get(userId);
			if (!userDataString) {
				return c.json({ error: 'Could not find credentials for user' }, 500);
			}
			let userData: UserData = JSON.parse(userDataString);

			if (userData.permanentlyFailed) {
				return c.json({ error: 'Your API key is no longer valid due to revoked Google authorization. Please register again.' }, 401);
			}

			const result = await forwardRequest(c, userData.credentials, userData.projectId, model, method, undefined, sse);

			if (result.permanentlyFailed) {
				userData.permanentlyFailed = true;
				c.executionCtx.waitUntil(c.env.KV.put(userId, JSON.stringify(userData)));
				return c.json({ error: 'Your API key is no longer valid due to revoked Google authorization. Please register again.' }, 401);
			}

			const { response, refreshedCredentials } = result;

			if (refreshedCredentials && refreshedCredentials.access_token !== userData.credentials.access_token) {
				userData.credentials = refreshedCredentials;
				c.executionCtx.waitUntil(c.env.KV.put(userId, JSON.stringify(userData)));
			}

			return processUpstreamResponse(c, response!);
		}
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
async function processUpstreamResponse(c: any, upstreamResponse: Response) {
	if (!upstreamResponse.ok) {
		return upstreamResponse; // Pass through error responses directly.
	}

	const sse = c.req.query('alt') === 'sse';

	if (sse) {
		if (!upstreamResponse.body) {
			return new Response('Upstream response has no body', { status: 500 });
		}
		const transformStream = new TransformStream(new SseUnwrapTransformer());
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


export default app;

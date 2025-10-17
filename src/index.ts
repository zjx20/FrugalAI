import { Hono, Context, Next } from 'hono';
import { PrismaClient } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import userApp from './user';
import adminApp from './admin';
import { ApiKeyThrottleHelper } from './core/throttle-helper';
import { AnthropicRequest, ApiKeyWithProvider, Credential, GeminiRequest, OpenAIRequest, Protocol, ProviderHandler, RequestContext, ThrottledError, UserWithKeys } from './core/types';
import { providerHandlerMap } from './providers/providers';
import { MessageCountTokensParams } from '@anthropic-ai/sdk/resources';

const MAX_LOG_BODY_LENGTH = 16 * 1024; // 16KB

export interface Env {
	DB: D1Database;
	ANTHROPIC_API_KEY?: string;
	ENVIRONMENT?: string;
}

type AppVariables = {
	db: Database;
	user: UserWithKeys;
	parsedBody?: any;
};

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Setup DB middleware
app.use('*', async (c, next) => {
	const adapter = new PrismaD1(c.env.DB);
	const prisma = new PrismaClient({ adapter });
	c.set('db', new Database(prisma));
	await next();
});

// JSON parsing middleware with error handling
const jsonBodyParser = async (c: Context<{ Bindings: Env; Variables: AppVariables }>, next: Next) => {
	if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
		const contentType = c.req.header('Content-Type');
		if (contentType?.includes('application/json')) {
			try {
				const body = await c.req.json();
				c.set('parsedBody', body);
			} catch (error) {
				const path = c.req.path;
				console.error(`[JSON Parse Error] Invalid JSON at ${path}:`, error);
				return c.json({
					error: 'Invalid JSON in request body',
					message: 'The request body contains malformed JSON',
					path: path
				}, 400);
			}
		}
	}
	await next();
	if (c.res.status === 400) {
		const text = await c.res.text() || '';
		let requestBodyStr = JSON.stringify(c.get('parsedBody'));
		if (requestBodyStr && requestBodyStr.length > MAX_LOG_BODY_LENGTH) {
			requestBodyStr = requestBodyStr.substring(0, MAX_LOG_BODY_LENGTH) + '... (truncated)';
		}
		console.error(`Upstream responded 400, path: ${c.req.path}, method: ${c.req.method}, response: ${text}, request: ${requestBodyStr}`);
		c.res = new Response(text, { status: 400, headers: c.res.headers });
	}
};

// --- Global Error Handling ---
app.onError((err, c) => {
	console.error('Unhandled error occurred:', err);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}

	const isDevelopment = c.env.ENVIRONMENT === 'development';

	return c.json({
		error: 'Internal Server Error',
		message: isDevelopment ? err.message : 'An unexpected error occurred. Please contact support.',
		stack: isDevelopment ? err.stack : undefined,
	}, 500);
});

// --- User Management API ---
app.route('/api', userApp);

// --- Admin Management API ---
app.route('/admin', adminApp);



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

	// 3. Check for x-api-key
	if (!token) {
		token = c.req.header('x-api-key');
	}

	// 4. Check for key query parameter
	if (!token) {
		token = c.req.query('key');
	}

	if (!token) {
		return c.json({ error: 'Unauthorized: No API key provided.' }, 401);
	}

	const db = c.get('db');
	let user: UserWithKeys | null = null;

	// Check if it's a new access token (starts with sk-api-)
	if (token.startsWith('sk-api-')) {
		const accessToken = await db.findAccessToken(token);
		if (accessToken) {
			user = await db.findUserById(accessToken.userId);
		}
	} else {
		// Legacy user token (starts with sk-)
		user = await db.findUserByToken(token);
	}

	if (!user) {
		return c.json({ error: 'Unauthorized: Invalid API key.' }, 401);
	}

	c.set('user', user);
	await next();
};

app.use('/v1/*', jsonBodyParser, proxyAuth);
app.use('/v1beta/*', jsonBodyParser, proxyAuth);

app.get('/available-models', proxyAuth, (c) => {
	const user = c.get('user');

	const providerModelsMap = new Map<string, Set<string>>();
	for (const key of user.keys) {
		if (key.permanentlyFailed || !key.provider.models) {
			continue;
		}

		const providerName = key.providerName;
		const models = Array.isArray(key.provider.models) ? (key.provider.models as string[]) : [];

		if (!providerModelsMap.has(providerName)) {
			providerModelsMap.set(providerName, new Set());
		}

		for (const model of models) {
			providerModelsMap.get(providerName)!.add(model);
		}
	}

	const availableModels = Array.from(providerModelsMap.entries()).map(([provider, models]) => ({
		provider,
		models: Array.from(models),
	}));

	return c.json(availableModels);
});

function extractModel(model: string): { provider?: string, model: string, alias?: string } {
	var provider: string | undefined = undefined;
	const pPos = model.indexOf('/');
	if (pPos >= 0) {
		provider = model.substring(0, pPos);
		model = model.substring(pPos + 1);
	}
	var alias: string | undefined = undefined;
	const aPos = model.lastIndexOf('$');
	if (aPos >= 0) {
		alias = model.substring(aPos + 1);
		model = model.substring(0, aPos);
	}
	return { provider, model, alias };
}

function matchModel(reqModelId: string, reqAlias: string | undefined, model: string): {matched: boolean, modelId: string} {
	const { model: modelId, alias } = extractModel(model);
	if (reqModelId === modelId) {
		// The alias name should be equal if it's specified
		if (reqAlias) {
			return {matched: reqAlias === alias, modelId: modelId};
		}
		// Match the modelId
		return {matched: true, modelId: modelId};
	}
	if (alias) {
		// Match the alias name
		return {matched: reqModelId === alias, modelId: modelId};
	}
	return {matched: false, modelId: modelId};
}

function resolveModelIds(reqModelId: string, reqAlias: string | undefined, key: ApiKeyWithProvider, handler: ProviderHandler): string[] {
	const models = key.provider.models as string[] || [];
	const result = [];
	const exists = new Set<string>();
	for (const model of models) {
		const {matched, modelId} = matchModel(reqModelId, reqAlias, model);
		if (matched && !exists.has(modelId)) {
			if (handler.canAccessModelWithKey(key, modelId)) {
				result.push(modelId);
				exists.add(modelId);
			}
		}
	}
	return result;
}

interface CandidateKey {
	key: ApiKeyWithProvider;
	modelIds: string[];
	consecutiveFailures: number;
}

function selectKeys(user: UserWithKeys, throttle: ApiKeyThrottleHelper, now: number, protocol: Protocol, reqModel: string, reqAlias?: string, provider?: string): CandidateKey[] {
	const result: CandidateKey[] = [];
	for (const key of user.keys) {
		// TODO: break early if there are too many keys
		if (((key.throttleData || {}) as any).paused) {
			continue; // Skip paused keys
		}
		if (provider && key.providerName !== provider) {
			continue;
		}
		const handler = providerHandlerMap.get(key.providerName);
		if (!handler) {
			continue;
		}
		if (!(handler.supportedProtocols() || []).includes(protocol)) {
			continue;
		}
		const modelIds = resolveModelIds(reqModel, reqAlias, key, handler);
		const eligibleModelIds = [];
		for (const modelId of modelIds) {
			const { throttled } = throttle.isModelThrottled(key, modelId, now);
			if (throttled) {
				continue;
			}
			eligibleModelIds.push(modelId);
		}
		if (eligibleModelIds.length === 0) {
			continue;
		}

		result.push({ key, modelIds: eligibleModelIds, consecutiveFailures: throttle.consecutiveFailuresOf(key, eligibleModelIds)});
	}

	// TODO: shuffle keys

	// Sort by consecutiveFailures
	result.sort((a, b) => a.consecutiveFailures - b.consecutiveFailures);

	return result;
}

async function getApiKeysAndHandleRequest(
	c: Context<{ Bindings: Env; Variables: AppVariables }>,
	protocol: Protocol,
	reqModels: string,
	fn: (handler: ProviderHandler, adjustedModel: string, cred: Credential) => Promise<Response | Error>): Promise<Response> {

	const user = c.get('user');
	const db = c.get('db');
	const errors: Error[] = [];
	for (const reqModel of reqModels.split(',')) {
		const throttle = new ApiKeyThrottleHelper(db);
		const { provider, model: reqModelId, alias: reqAlias } = extractModel(reqModel);
		const candKeys = selectKeys(user, throttle, Date.now(), protocol, reqModelId, reqAlias, provider);
		if (candKeys.length == 0) {
			errors.push(new Error(`No keys available for model "${reqModel}" with protocol "${protocol}"${provider ? ' and provider "' + provider : '"'}`));
			continue;
		}
		for await (const candKey of candKeys) {
			const key = candKey.key;
			const handler = providerHandlerMap.get(key.providerName);
			if (!handler) {
				continue;
			}
			const modelIds = candKey.modelIds;
			for (const modelId of modelIds) {
				const response = await fn(handler, modelId, { apiKey: key, feedback: throttle });
				if (response instanceof Error) {
					let resetTime: number | undefined;
					if (response instanceof ThrottledError) {
						resetTime = response.resetTime;
					}
					const isRateLimited = response instanceof ThrottledError;
					throttle.recordModelStatus(key, modelId, false, isRateLimited, response.message, resetTime); // Report failure for the model
					errors.push(response);
					continue;
				}
				if (!response.ok && response.status !== 400) {
					// Ignore bad request error
					const errMsg = `Response is not ok, status: ${response.status} ${response.statusText}`;
					throttle.recordModelStatus(key, modelId, false, false, errMsg); // Report failure for the model
					console.error(errMsg);
				}
				await throttle.commitPending(c.executionCtx);
				return response;
			}
		}
		await throttle.commitPending(c.executionCtx);
	}
	if (errors.length > 0) {
		const throttled = errors.some(e => e instanceof ThrottledError);
		if (throttled) {
			console.error(`Error occurred or throttled, details: ${errors.map(e => e.message)}`);
			return c.json({ error: 'ApiKeys were rate-limited', details: errors.map(e => e.message) }, 429);
		}
		console.error(`Error occurred, details: ${errors.map(e => e.message)}`);
		return c.json({ error: 'Error occurred', details: errors.map(e => e.message) }, 500);
	}
	return c.json({ error: 'ApiKeys were rate-limited' }, 429);
}

app.post('/v1/chat/completions', async (c) => {
	const ctx: RequestContext = {
		executionCtx: c.executionCtx,
		request: c.req.raw,
	};
	const openAIRequestBody: OpenAIRequest = c.get('parsedBody');
	return getApiKeysAndHandleRequest(c, Protocol.OpenAI, openAIRequestBody.model, async (handler, adjustedModelId, cred) => {
		openAIRequestBody.model = adjustedModelId;
		return handler.handleOpenAIRequest(ctx, openAIRequestBody, cred);
	});
});

app.post('/v1beta/models/:modelAndMethod{(([a-zA-Z0-9_-]+\\/)?[a-zA-Z0-9.-]+(\\$[a-zA-Z0-9.-]+)?(,([a-zA-Z0-9_-]+\\/)?[a-zA-Z0-9.-]+(\\$[a-zA-Z0-9.-]+)?)*):[a-zA-Z]+}', async (c) => {
	const ctx: RequestContext = {
		executionCtx: c.executionCtx,
		request: c.req.raw,
	};
	// model pattern: [provider/]model[$alias]
	// modelAndMethod pattern: model1[,model2[,model3...]]:method
	const modelAndMethod = c.req.param('modelAndMethod');
	const [reqModels, method] = modelAndMethod.split(':');
	const sse = c.req.query('alt') === 'sse';

	const requestBody = c.get('parsedBody');
	const geminiRequest: GeminiRequest = {
		model: "", // placeholder
		method: method,
		sse: sse,
		request: requestBody,
	};

	return getApiKeysAndHandleRequest(c, Protocol.Gemini, reqModels, async (handler, adjustedModelId, cred) => {
		geminiRequest.model = adjustedModelId;
		return handler.handleGeminiRequest(ctx, geminiRequest, cred);
	});
});

app.post('/v1/messages', async (c) => {
	const ctx: RequestContext = {
		executionCtx: c.executionCtx,
		request: c.req.raw,
	};
	const anthropicRequest: AnthropicRequest = c.get('parsedBody');
	return getApiKeysAndHandleRequest(c, Protocol.Anthropic, anthropicRequest.model, async (handler, adjustedModelId, cred) => {
		anthropicRequest.model = adjustedModelId;
		return handler.handleAnthropicRequest(ctx, anthropicRequest, cred);
	});
});

// Token counting helper function
function estimateTokenCount(body: MessageCountTokensParams): number {
	let totalTokens = 0;

	// Estimate tokens from messages
	if (body.messages && Array.isArray(body.messages)) {
		for (const message of body.messages) {
			if (typeof message.content === 'string') {
				// Simple text content: ~4 chars per token
				totalTokens += Math.ceil(message.content.length / 4);
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === 'text' && block.text) {
						// Text block: ~4 chars per token
						totalTokens += Math.ceil(block.text.length / 4);
					} else if (block.type === 'image') {
						// Image estimation based on Anthropic's pricing:
						// Images are tokenized differently based on size
						// Rough estimate: ~1500 tokens per image (conservative average)
						totalTokens += 1500;
					} else if (block.type === 'document' && block.source) {
						// PDF document estimation
						// According to docs, PDFs can vary widely
						// Conservative estimate based on typical PDF: ~2000-3000 tokens
						// We'll use data length as a rough proxy if available
						if (block.source.type === 'base64' && block.source.data) {
							// Base64 encoded data length / 6000 gives rough page estimate
							// Each page ~200-300 tokens
							const estimatedPages = Math.max(1, Math.ceil(block.source.data.length / 6000));
							totalTokens += estimatedPages * 250;
						} else {
							// Default estimate for unknown PDF
							totalTokens += 2000;
						}
					} else if (block.type === 'thinking' && block.thinking) {
						// Extended thinking blocks (from previous assistant turns are ignored per docs)
						// But current turn thinking is counted
						// Note: The API documentation states thinking from PREVIOUS turns
						// is NOT counted, but we can't determine which turn this is from
						// the request alone. For safety, we'll estimate it.
						totalTokens += Math.ceil(block.thinking.length / 4);
					} else if (block.type === 'tool_use') {
						// Tool use blocks: estimate based on JSON size
						totalTokens += Math.ceil(JSON.stringify(block).length / 4);
					} else if (block.type === 'tool_result') {
						// Tool result blocks
						if (typeof block.content === 'string') {
							totalTokens += Math.ceil(block.content.length / 4);
						} else if (Array.isArray(block.content)) {
							// Recursive handling for tool result content blocks
							for (const resultBlock of block.content) {
								if (resultBlock.type === 'text' && resultBlock.text) {
									totalTokens += Math.ceil(resultBlock.text.length / 4);
								} else if (resultBlock.type === 'image') {
									totalTokens += 1500;
								}
							}
						}
					}
				}
			}
		}
	}

	// Estimate tokens from system prompt
	if (body.system) {
		if (typeof body.system === 'string') {
			totalTokens += Math.ceil(body.system.length / 4);
		} else if (Array.isArray(body.system)) {
			for (const block of body.system) {
				if (block.type === 'text' && block.text) {
					totalTokens += Math.ceil(block.text.length / 4);
				}
			}
		}
	}

	// Estimate tokens from tools
	// Tools add significant overhead due to schema definitions
	if (body.tools && Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			// Each tool definition: name + description + schema
			// Schema can be quite large, use JSON length / 3 for better estimate
			const toolJson = JSON.stringify(tool);
			totalTokens += Math.ceil(toolJson.length / 3);
		}
	}

	// Extended thinking budget (if specified)
	if (body.thinking && typeof body.thinking === 'object' && 'budget_tokens' in body.thinking) {
		// The budget_tokens is the MAX tokens, not used tokens
		// We don't add this to the input count as it's output budget
		// But we should note it exists in case of future consideration
	}

	return totalTokens;
}

app.post('/v1/messages/count_tokens', jsonBodyParser, proxyAuth, async (c) => {
	const requestBody = c.get('parsedBody');
	const anthropicApiKey = c.env.ANTHROPIC_API_KEY;

	// If ANTHROPIC_API_KEY is not set, estimate tokens and return with warning
	if (!anthropicApiKey) {
		const estimatedTokens = estimateTokenCount(requestBody);

		return c.json(
			{
				input_tokens: estimatedTokens
			},
			200,
			{
				'Warning': '199 - "Token count is estimated. Set ANTHROPIC_API_KEY secret for accurate counts."'
			}
		);
	}

	// Forward request to official Anthropic API
	try {
		const anthropicVersion = c.req.header('anthropic-version') || '2023-06-01';
		const anthropicBeta = c.req.header('anthropic-beta');

		const headers: Record<string, string> = {
			'x-api-key': anthropicApiKey,
			'anthropic-version': anthropicVersion,
			'content-type': 'application/json',
		};

		if (anthropicBeta) {
			headers['anthropic-beta'] = anthropicBeta;
		}

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(requestBody),
		});

		// Return the response from Anthropic API
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		console.error('Error calling Anthropic count_tokens API:', error);

		// Fall back to estimation if API call fails
		const estimatedTokens = estimateTokenCount(requestBody);

		return c.json(
			{
				input_tokens: estimatedTokens,
				error: 'Failed to reach Anthropic API, returning estimate'
			},
			200,
			{
				'Warning': '199 - "Token count is estimated due to API error."'
			}
		);
	}
});

export default app;

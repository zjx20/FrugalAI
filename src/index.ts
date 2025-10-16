import { Hono, Context, Next } from 'hono';
import { PrismaClient } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import userApp from './user';
import adminApp from './admin';
import { ApiKeyThrottleHelper } from './core/throttle-helper';
import { AnthropicRequest, ApiKeyWithProvider, Credential, GeminiRequest, OpenAIRequest, Protocol, ProviderHandler, ThrottledError, UserWithKeys } from './core/types';
import { providerHandlerMap } from './providers/providers';

export interface Env {
	DB: D1Database;
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
		console.error(`Upstream respond 400, path: ${c.req.path}, method: ${c.req.method}, body: ${JSON.stringify(c.get('parsedBody'))}`);
	}
};

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
					const isRateLimited = response instanceof ThrottledError;
					throttle.recordModelStatus(key, modelId, false, isRateLimited, response.message); // Report failure for the model
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
	const openAIRequestBody: OpenAIRequest = c.get('parsedBody');
	return getApiKeysAndHandleRequest(c, Protocol.OpenAI, openAIRequestBody.model, async (handler, adjustedModelId, cred) => {
		openAIRequestBody.model = adjustedModelId;
		return handler.handleOpenAIRequest(c.executionCtx, openAIRequestBody, cred);
	});
});

app.post('/v1beta/models/:modelAndMethod{(([a-zA-Z0-9_-]+\\/)?[a-zA-Z0-9.-]+(\\$[a-zA-Z0-9.-]+)?(,([a-zA-Z0-9_-]+\\/)?[a-zA-Z0-9.-]+(\\$[a-zA-Z0-9.-]+)?)*):[a-zA-Z]+}', async (c) => {
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
		return handler.handleGeminiRequest(c.executionCtx, geminiRequest, cred);
	});
});

app.post('/v1/messages', async (c) => {
	const anthropicRequest: AnthropicRequest = c.get('parsedBody');
	return getApiKeysAndHandleRequest(c, Protocol.Anthropic, anthropicRequest.model, async (handler, adjustedModelId, cred) => {
		anthropicRequest.model = adjustedModelId;
		return handler.handleAnthropicRequest(c.executionCtx, anthropicRequest, cred);
	});
});

export default app;

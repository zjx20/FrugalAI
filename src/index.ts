import { Hono, Context, Next } from 'hono';
import { PrismaClient } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import userApp from './user';
import adminApp from './admin';
import { ApiKeyThrottleHelper } from './core/throttle-helper';
import { ApiKeyWithProvider, Credential, GeminiRequest, OpenAIRequest, Protocol, ProviderHandler, ThrottledError, UserWithKeys } from './core/types';
import { providerHandlerMap } from './providers/providers';

export interface Env {
	DB: D1Database;
}

type AppVariables = {
	db: Database;
	user: UserWithKeys;
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

	// 3. Check for key query parameter
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

app.use('/v1/*', proxyAuth);
app.use('/v1beta/*', proxyAuth);

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

function resolveModelId(reqModelId: string, reqAlias: string | undefined, key: ApiKeyWithProvider, handler: ProviderHandler): string | undefined {
	const models = key.provider.models as string[] || [];
	for (const model of models) {
		const {matched, modelId} = matchModel(reqModelId, reqAlias, model);
		if (matched) {
			if (handler.canAccessModelWithKey(key, modelId)) {
				return modelId;
			}
		}
	}
	return;
}

async function selectKeys(user: UserWithKeys, protocol: Protocol, model: string, alias?: string, provider?: string): Promise<ApiKeyWithProvider[]> {
	const result = [];
	for (const key of user.keys) {
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
		const modelId = resolveModelId(model, alias, key, handler);
		if (!modelId) {
			continue;
		}
		result.push(key);
	}
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
		const { provider, model: reqModelId, alias: reqAlias } = extractModel(reqModel);
		const keys = await selectKeys(user, protocol, reqModelId, reqAlias, provider);
		if (keys.length == 0) {
			errors.push(new Error(`No keys available for model "${reqModel}"`));
			continue;
		}
		const throttle = new ApiKeyThrottleHelper(keys, db, undefined, reqModelId);
		for await (const key of throttle.getAvailableKeys()) {
			const handler = providerHandlerMap.get(key.providerName);
			if (!handler) {
				continue;
			}
			const modelId = resolveModelId(reqModelId, reqAlias, key, handler);
			if (!modelId) {
				continue;
			}
			const response = await fn(handler, modelId, { apiKey: key, feedback: throttle });
			if (response instanceof Error) {
				errors.push(response);
				continue;
			}
			return response;
		}
	}
	if (errors.length > 0) {
		const throttled = errors.some(e => e instanceof ThrottledError);
		if (throttled) {
			return c.json({ error: 'ApiKeys were rate-limited', details: errors.map(e => e.message) }, 429);
		}
		return c.json({ error: 'Error occurred', details: errors.map(e => e.message) }, 500);
	}
	return c.json({ error: 'ApiKeys were rate-limited' }, 429);
}

app.post('/v1/chat/completions', async (c) => {
	const openAIRequestBody: OpenAIRequest = await c.req.json();
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

	const requestBody = await c.req.json();
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

export default app;

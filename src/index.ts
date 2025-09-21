import { Hono, Context, Next } from 'hono';
import { PrismaClient } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import userApp from './user';
import adminApp from './admin';
import { ApiKeyThrottleHelper } from './core/throttle-helper';
import { ApiKeyWithProvider, Credential, GeminiRequest, OpenAIRequest, ProviderHandler, ThrottledError, UserWithKeys } from './core/types';
import { providerHandlerMap } from './core/providers';

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
	const user = await db.findUserByToken(token);

	if (!user) {
		return c.json({ error: 'Unauthorized: Invalid API key.' }, 401);
	}

	c.set('user', user);
	await next();
};

app.use('/v1/*', proxyAuth);
app.use('/v1beta/*', proxyAuth);

async function selectKeys(user: UserWithKeys, model: string): Promise<ApiKeyWithProvider[]> {
	const result = [];
	for (const key of user.keys) {
		const handler = providerHandlerMap.get(key.providerName);
		if (!handler) {
			continue;
		}
		if ((key.provider.models as string[] || []).includes(model)) {
			result.push(key);
		}
	}
	return result;
}

async function getApiKeysAndHandleRequest(c: Context<{ Bindings: Env; Variables: AppVariables }>, model: string, fn: (handler: ProviderHandler, cred: Credential) => Promise<Response | Error>): Promise<Response> {
	const user = c.get('user');
	const db = c.get('db');
	const keys = await selectKeys(user, model);
	if (keys.length == 0) {
		return c.json({ error: `No keys available for this model "{model}"` }, 500);
	}
	const errors: Error[] = [];
	const throttle = new ApiKeyThrottleHelper(keys, db, undefined, model);
	for await (const key of throttle.getAvailableKeys()) {
		const handler = providerHandlerMap.get(key.providerName);
		if (!handler) {
			continue;
		}
		const response = await fn(handler, { apiKey: key, feedback: throttle });
		if (response instanceof Error) {
			errors.push(response);
			continue;
		}
		return response;
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

function extractModel(model: string): string {
	const parts = model.split(':');
	if (parts.length === 2) {
		return parts[1];
	}
	return model;
}

app.post('/v1/chat/completions', async (c) => {
	const openAIRequestBody: OpenAIRequest = await c.req.json();
	const model = extractModel(openAIRequestBody.model);
	return getApiKeysAndHandleRequest(c, model, async (handler, cred) => {
		return handler.handleOpenAIRequest(c.executionCtx, openAIRequestBody, cred);
	});
});

app.post('/v1beta/models/:modelAndMethod{[a-zA-Z0-9.-]+:[a-zA-Z]+}', async (c) => {
	const modelAndMethod = c.req.param('modelAndMethod');
	const [model, method] = modelAndMethod.split(':');
	const sse = c.req.query('alt') === 'sse';

	const requestBody = await c.req.json();
	const geminiRequest: GeminiRequest = {
		model: model,
		method: method,
		sse: sse,
		request: requestBody,
	};

	return getApiKeysAndHandleRequest(c, model, async (handler, cred) => {
		return handler.handleGeminiRequest(c.executionCtx, geminiRequest, cred);
	});
});

export default app;

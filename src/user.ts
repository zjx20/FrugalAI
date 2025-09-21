import { PrismaClient, ProviderName } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';

type Env = {
	DB: D1Database;
};

type Variables = {
	user: any;
	db: Database;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// A simple utility to generate random tokens
function generateToken(length = 32) {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let token = '';
	for (let i = 0; i < length; i++) {
		token += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return token;
}

app.use('*', async (c, next) => {
	const adapter = new PrismaD1(c.env.DB);
	const prisma = new PrismaClient({ adapter });
	c.set('db', new Database(prisma));
	await next();
});

app.post('/user/register', async (c) => {
	const db = c.get('db');
	try {
		const { name } = (await c.req.json()) as { name?: string };
		const token = `sk-${generateToken(48)}`;
		const user = await db.createUser(token, name);
		return c.json({ token: user.token });
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

app.use('/user/keys/*', bearerAuth({
	verifyToken: async (token, c) => {
		const db = c.get('db');
		const user = await db.findUserByToken(token);
		if (user) {
			c.set('user', user);
			return true;
		}
		return false;
	}
}));

app.use('/user/available-models', bearerAuth({
	verifyToken: async (token, c) => {
		const db = c.get('db');
		const user = await db.findUserByToken(token);
		if (user) {
			c.set('user', user);
			return true;
		}
		return false;
	}
}));

app.get('/user/keys', (c) => {
	const user = c.get('user');
	return c.json(user.keys);
});

app.get('/user/available-models', (c) => {
	const user = c.get('user');
	const availableModels: { provider: string, models: string[] }[] = [];

	// Group models by provider
	const providerModelsMap = new Map<string, string[]>();

	user.keys.forEach((key: any) => {
		if (!key.permanentlyFailed && key.provider.models) {
			const providerName = key.providerName;
			const models = key.provider.models as string[];

			if (!providerModelsMap.has(providerName)) {
				providerModelsMap.set(providerName, []);
			}

			// Add models that aren't already in the list
			models.forEach(model => {
				const existingModels = providerModelsMap.get(providerName)!;
				if (!existingModels.includes(model)) {
					existingModels.push(model);
				}
			});
		}
	});

	// Convert map to array format
	providerModelsMap.forEach((models, provider) => {
		availableModels.push({ provider, models });
	});

	return c.json(availableModels);
});

app.post('/user/keys', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	try {
		const { providerName, keyData, notes } = (await c.req.json()) as { providerName: string; keyData: any, notes?: string };
		if (!providerName || !keyData) {
			return c.json({ error: 'Missing providerName or keyData' }, 400);
		}
		if (!Object.values(ProviderName).includes(providerName as ProviderName)) {
			return c.json({ error: 'Unsupported provider' }, 400);
		}
		const apiKey = await db.createApiKey(user.id, providerName as ProviderName, keyData, notes);
		return c.json(apiKey, 201);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

app.delete('/user/keys/:id', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const keyId = parseInt(c.req.param('id'), 10);

	try {
		const keyToDelete = await db.getApiKeyById(keyId);
		if (!keyToDelete || keyToDelete.ownerId !== user.id) {
			return c.json({ error: 'API Key not found or you do not have permission' }, 404);
		}
		await db.deleteApiKey(keyId);
		return new Response(null, { status: 204 });
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

app.get('/providers', async (c) => {
	const db = c.get('db');
	try {
		const providers = await db.getAllProviders();
		return c.json(providers.map(p => p.name));
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

export default app;

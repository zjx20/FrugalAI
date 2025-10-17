import { PrismaClient, ProviderName } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';
import { Database } from './core/db';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { UserWithKeys } from './core/types';

type Env = {
	DB: D1Database;
};

type Variables = {
	user: UserWithKeys;
	db: Database;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const authMiddleware = bearerAuth({
	verifyToken: async (token, c) => {
		const db = c.get('db');
		const user = await db.findUserByToken(token);
		if (user) {
			c.set('user', user);
			return true;
		}
		return false;
	}
});

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
	const { name } = (await c.req.json()) as { name?: string };
	const token = `sk-${generateToken(48)}`;
	const user = await db.createUser(token, name);
	return c.json({ token: user.token });
});

app.use('/user/keys', authMiddleware);
app.use('/user/key', authMiddleware);
app.use('/user/key/reset', authMiddleware);
app.use('/user/access-tokens', authMiddleware);
app.use('/user/access-token', authMiddleware);


app.get('/user/keys', (c) => {
	const user = c.get('user');
	return c.json(user.keys);
});


app.post('/user/keys', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { providerName, keyData, notes } = (await c.req.json()) as { providerName: string; keyData: any, notes?: string };
	if (!providerName || !keyData) {
		return c.json({ error: 'Missing providerName or keyData' }, 400);
	}
	if (!Object.values(ProviderName).includes(providerName as ProviderName)) {
		return c.json({ error: 'Unsupported provider' }, 400);
	}
	const apiKey = await db.createApiKey(user.id, providerName as ProviderName, keyData, notes);
	return c.json(apiKey, 201);
});

app.delete('/user/key', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { id } = (await c.req.json()) as { id: number };

	const keyToDelete = await db.getApiKeyById(id);
	if (!keyToDelete || keyToDelete.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}
	await db.deleteApiKey(id);
	return new Response(null, { status: 204 });
});

app.put('/user/key', async (c) => {
	const db = c.get('db');
	const user = c.get('user');

	const { id, keyData, notes } = (await c.req.json()) as { id: number; keyData?: any; notes?: string };
	const keyToUpdate = await db.getApiKeyById(id);

	if (!keyToUpdate || keyToUpdate.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}

	const updatedKey = await db.updateApiKeyDetails(id, {
		keyData: keyData || undefined,
		notes: notes || undefined,
	});

	return c.json(updatedKey);
});

app.post('/user/key/reset', async (c) => {
	const db = c.get('db');
	const user = c.get('user');

	const { id } = (await c.req.json()) as { id: number };
	const keyToReset = await db.getApiKeyById(id);

	if (!keyToReset || keyToReset.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}

	// Check if the key is paused - if so, just unpause it
	const throttleData = keyToReset.throttleData as any;
	if (throttleData && throttleData.paused) {
		const unpaused = await db.unpauseApiKey(id);
		return c.json(unpaused);
	}

	// Otherwise, do a full reset
	const resetKey = await db.resetApiKeyStatus(id);
	return c.json(resetKey);
});

app.use('/user/key/pause', authMiddleware);
app.post('/user/key/pause', async (c) => {
	const db = c.get('db');
	const user = c.get('user');

	const { id } = (await c.req.json()) as { id: number };
	const keyToPause = await db.getApiKeyById(id);

	if (!keyToPause || keyToPause.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}

	const pausedKey = await db.pauseApiKey(id);
	return c.json(pausedKey);
});

// Access Token management endpoints

app.get('/user/access-tokens', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const tokens = await db.getUserAccessTokens(user.id);
	return c.json(tokens);
});

app.post('/user/access-tokens', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { name } = (await c.req.json()) as { name?: string };
	const token = `sk-api-${generateToken(48)}`;
	const accessToken = await db.createAccessToken(token, user.id, name);
	return c.json(accessToken, 201);
});

app.delete('/user/access-token', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { id } = (await c.req.json()) as { id: number };

	// Verify the token belongs to the user
	const tokens = await db.getUserAccessTokens(user.id);
	const tokenToRevoke = tokens.find(t => t.id === id);

	if (!tokenToRevoke) {
		return c.json({ error: 'Access token not found or you do not have permission' }, 404);
	}

	await db.revokeAccessToken(id);
	return new Response(null, { status: 204 });
});

app.get('/providers', async (c) => {
	const db = c.get('db');
	const providers = await db.getAllProviders();
	return c.json(providers.map(p => p.name));
});

// Model Alias management endpoints

app.use('/user/model-aliases', authMiddleware);

app.get('/user/model-aliases', async (c) => {
	const user = c.get('user');
	const modelAliases = user.modelAliases || {};
	return c.json(modelAliases);
});

app.put('/user/model-aliases', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { alias, models } = (await c.req.json()) as { alias: string; models: string };

	if (!alias || !models) {
		return c.json({ error: 'Missing alias or models parameter' }, 400);
	}

	// Validate alias format
	if (!/^[a-zA-Z0-9\.\/_-]+$/.test(alias)) {
		return c.json({ error: 'Alias must contain only alphanumeric characters, hyphens, slashes, dots, and underscores' }, 400);
	}

	// Get current aliases
	const currentAliases = (user.modelAliases as Record<string, string>) || {};

	// Update or add the alias
	currentAliases[alias] = models;

	// Save to database
	await db.updateUserModelAliases(user.id, currentAliases);

	return c.json({ success: true, aliases: currentAliases });
});

app.delete('/user/model-aliases', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { alias } = (await c.req.json()) as { alias: string };

	if (!alias) {
		return c.json({ error: 'Missing alias parameter' }, 400);
	}

	// Get current aliases
	const currentAliases = (user.modelAliases as Record<string, string>) || {};

	// Check if alias exists
	if (!currentAliases[alias]) {
		return c.json({ error: 'Alias not found' }, 404);
	}

	// Remove the alias
	delete currentAliases[alias];

	// Save to database
	await db.updateUserModelAliases(user.id, Object.keys(currentAliases).length > 0 ? currentAliases : null);

	return c.json({ success: true, aliases: currentAliases });
});

export default app;

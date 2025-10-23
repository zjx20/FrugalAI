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
	const { providerName, keyData, notes, baseUrl, availableModels } = (await c.req.json()) as {
		providerName: string;
		keyData: any;
		notes?: string;
		baseUrl?: string;
		availableModels?: string[];
	};
	if (!providerName || !keyData) {
		return c.json({ error: 'Missing providerName or keyData' }, 400);
	}
	if (!Object.values(ProviderName).includes(providerName as ProviderName)) {
		return c.json({ error: 'Unsupported provider' }, 400);
	}

	// Create the API key first
	const apiKey = await db.createApiKey(user.id, providerName as ProviderName, keyData, notes);

	// Update baseUrl and availableModels if provided
	if (baseUrl !== undefined || availableModels !== undefined) {
		await db.updateApiKeyExtendedFields(apiKey.id, { baseUrl, availableModels });
	}

	// Fetch and return the complete key with provider info
	const completeKey = await db.getApiKeyById(apiKey.id);
	return c.json(completeKey, 201);
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

	const { id, keyData, notes, baseUrl, availableModels } = (await c.req.json()) as {
		id: number;
		keyData?: any;
		notes?: string;
		baseUrl?: string;
		availableModels?: string[] | null;
	};
	const keyToUpdate = await db.getApiKeyById(id);

	if (!keyToUpdate || keyToUpdate.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}

	// Update basic fields
	if (keyData !== undefined || notes !== undefined) {
		await db.updateApiKeyDetails(id, {
			keyData: keyData || undefined,
			notes: notes || undefined,
		});
	}

	// Update baseUrl and/or availableModels if provided
	if (baseUrl !== undefined || availableModels !== undefined) {
		await db.updateApiKeyExtendedFields(id, { baseUrl, availableModels });
	}

	// Fetch and return the complete updated key
	const updatedKey = await db.getApiKeyById(id);
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

	// Do a full reset, which also unpauses the key by resetting its status.
	const resetKey = await db.resetApiKeyStatus(id);
	return c.json(resetKey);
});

app.use('/user/key/pause', authMiddleware);
app.use('/user/key/unpause', authMiddleware);

app.post('/user/key/unpause', async (c) => {
	const db = c.get('db');
	const user = c.get('user');

	const { id } = (await c.req.json()) as { id: number };
	const keyToUnpause = await db.getApiKeyById(id);

	if (!keyToUnpause || keyToUnpause.ownerId !== user.id) {
		return c.json({ error: 'API Key not found or you do not have permission' }, 404);
	}

	const unpausedKey = await db.unpauseApiKey(id);
	return c.json(unpausedKey);
});

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
	return c.json(providers.map(p => ({ name: p.name, displayName: p.displayName })));
});

// Model Settings management endpoints

app.use('/user/model-settings', authMiddleware);

app.get('/user/model-settings', async (c) => {
	const user = c.get('user');
	const modelSettings = user.modelSettings || {};
	return c.json(modelSettings);
});

app.put('/user/model-settings', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { modelSettings } = (await c.req.json()) as {
		modelSettings: Record<string, {
			alias?: string;
			providerPriorities?: Record<string, number>;
		}>
	};

	if (!modelSettings || typeof modelSettings !== 'object') {
		return c.json({ error: 'Invalid modelSettings parameter' }, 400);
	}

	// Validate the structure
	for (const [modelName, settings] of Object.entries(modelSettings)) {
		// Validate model name format
		if (!/^[a-zA-Z0-9\.\/_-]+$/.test(modelName)) {
			return c.json({
				error: `Invalid model name "${modelName}". Must contain only alphanumeric characters, hyphens, slashes, dots, and underscores`
			}, 400);
		}

		// Validate settings structure
		if (settings.alias !== undefined && typeof settings.alias !== 'string') {
			return c.json({ error: `Invalid alias for model "${modelName}"` }, 400);
		}

		if (settings.providerPriorities !== undefined) {
			if (typeof settings.providerPriorities !== 'object') {
				return c.json({ error: `Invalid providerPriorities for model "${modelName}"` }, 400);
			}
			// Validate each priority is a number
			for (const [provider, priority] of Object.entries(settings.providerPriorities)) {
				if (typeof priority !== 'number') {
					return c.json({
						error: `Invalid priority value for provider "${provider}" in model "${modelName}". Must be a number.`
					}, 400);
				}
			}
		}
	}

	// Save to database
	await db.updateUserModelSettings(user.id, modelSettings);

	return c.json({ success: true, modelSettings });
});

app.delete('/user/model-settings', async (c) => {
	const db = c.get('db');
	const user = c.get('user');
	const { modelName } = (await c.req.json()) as { modelName: string };

	if (!modelName) {
		return c.json({ error: 'Missing modelName parameter' }, 400);
	}

	// Get current settings
	const currentSettings = (user.modelSettings as Record<string, any>) || {};

	// Check if model exists
	if (!currentSettings[modelName]) {
		return c.json({ error: 'Model settings not found' }, 404);
	}

	// Remove the model settings
	delete currentSettings[modelName];

	// Save to database
	await db.updateUserModelSettings(user.id, Object.keys(currentSettings).length > 0 ? currentSettings : null);

	return c.json({ success: true, modelSettings: currentSettings });
});

export default app;

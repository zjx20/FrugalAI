import { Hono } from 'hono';
import { OAuth2Client } from 'google-auth-library';

// These are still needed for the revoke endpoint
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';

export interface Env {
	KV: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.post('/register', async (c) => {
    try {
        const { credentials: encodedCredentials } = await c.req.json();
        if (!encodedCredentials) {
            return c.json({ error: 'Encoded credentials are required.' }, 400);
        }

        const credentialsString = Buffer.from(encodedCredentials, 'base64').toString('utf-8');
        const tokens = JSON.parse(credentialsString);

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
});

// Sample API endpoint demonstrating API key authentication
app.post('/api/v1/models/gemini-pro:generateContent', async (c) => {
    const apiKey = c.req.query('key');
    if (!apiKey) {
        return c.json({ error: 'API key is missing' }, 401);
    }

    const userId = await c.env.KV.get(`apikey:${apiKey}`);
    if (!userId) {
        return c.json({ error: 'Invalid API key' }, 401);
    }

    const userDataString = await c.env.KV.get(userId);
    if (!userDataString) {
        return c.json({ error: 'Could not find credentials for user' }, 500);
    }

	const { credentials } = JSON.parse(userDataString);

    // TODO: Add logic here to use the credentials to call the real Google API

    return c.json({
        message: 'Authenticated successfully!',
        userId: userId,
        // In a real scenario, you would return the response from the Google API
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": "This is a placeholder response."
                        }
                    ],
                    "role": "model"
                }
            }
        ]
    });
});


export default app;

import { Hono } from 'hono';
import { OAuth2Client } from 'google-auth-library';
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from '@google/gemini-cli-core/dist/src/code_assist/server';

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
			console.error('Unprocessed buffer remaining at the end of the stream:', this.buffer);
			controller.enqueue(this.encoder.encode(this.buffer));
		}
	}
}

app.post('/v1beta/models/:modelAndMethod{[a-zA-Z0-9.-]+:[a-zA-Z]+}', async (c) => {
	const apiKey = c.req.query('key') || c.req.header('x-goog-api-key');
	if (!apiKey) {
		return c.json({ error: 'API key is missing' }, 401);
	}

	const modelAndMethod = c.req.param('modelAndMethod');
	const [model, method] = modelAndMethod.split(':');
	// if (!['generateContent', 'streamGenerateContent'].includes(method)) {
	// 	return c.json({ error: `Invalid method "${method}"` }, 400);
	// }
	console.log(`model: ${model}, method: ${method}`);

	const userId = await c.env.KV.get(`apikey:${apiKey}`);
	if (!userId) {
		return c.json({ error: 'Invalid API key' }, 401);
	}

	const userDataString = await c.env.KV.get(userId);
	if (!userDataString) {
		return c.json({ error: 'Could not find credentials for user' }, 500);
	}

	const { credentials, projectId } = JSON.parse(userDataString);
	const originalAccessToken = credentials.access_token;

	const client = new OAuth2Client({
		clientId: OAUTH_CLIENT_ID, // Still needed for token refresh
		clientSecret: OAUTH_CLIENT_SECRET, // Still needed for token refresh
	});
	client.setCredentials(credentials);

	// This will get a valid token, refreshing it only if it's expired or about to expire.
	await client.getAccessToken();
	const refreshedCredentials = client.credentials;

	// If the access token was refreshed, update it in the KV store for subsequent requests.
	// We use waitUntil to avoid blocking the response to the user.
	if (refreshedCredentials.access_token !== originalAccessToken) {
		const updatedUserData = { ...JSON.parse(userDataString), credentials: refreshedCredentials };
		c.executionCtx.waitUntil(c.env.KV.put(userId, JSON.stringify(updatedUserData)));
	}

	const version = process.env.CLI_VERSION || process.version;
	const userAgent = `GeminiCLI/${version} (${process.platform}; ${process.arch})`;

	try {
		const requestBody = await c.req.json();
		const body = {
			model: model,
			project: projectId,
			request: requestBody,
		}
		const headers = new Headers();
		headers.append('Content-Type', 'application/json');
		headers.append('User-Agent', userAgent);
		headers.append('Authorization', `Bearer ${refreshedCredentials.access_token}`);

		const url = new URL(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`);
		const queries = c.req.queries();
		for (const k in queries) {
			for (const v of queries[k]) {
				url.searchParams.append(k, v);
			}
		}
		// Remove our API key from the query params
		url.searchParams.delete('key');

		const sse = (url.searchParams.get('alt') === 'sse');
		if (!sse) {
			const resp = await fetch(url, {
				method: c.req.method,
				headers: headers,
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				return resp;
			}
			let respObj: any = await resp.json();

			// The response from the Code Assist API wraps the actual Gemini response.
			// We need to unwrap it here to match the standard Gemini API format.
			if (Array.isArray(respObj)) {
				// It's an array of responses, likely from a streaming-like call.
				// We extract the 'response' object from each element.
				const unwrapped = [];
				for (const obj of respObj) {
					if (obj && obj.response) {
						unwrapped.push(obj.response);
					}
				}
				respObj = unwrapped;
			} else if (respObj && typeof respObj === 'object' && respObj.response) {
				// It's a single response object.
				respObj = respObj.response;
			}
			return c.json(respObj);
		} else {
			// For SSE, we fetch the stream from the upstream and transform it on the fly.
			const upstreamResponse = await fetch(url, {
				method: c.req.method,
				headers: headers,
				body: JSON.stringify(body),
			});

			if (!upstreamResponse.ok) {
				return upstreamResponse; // Pass through error responses directly.
			}

			if (!upstreamResponse.body) {
				return new Response('Upstream response has no body', { status: 500 });
			}

			const transformStream = new TransformStream(new SseUnwrapTransformer());
			const transformedBody = upstreamResponse.body.pipeThrough(transformStream);

			const responseHeaders = new Headers();
			responseHeaders.set('Content-Type', 'text/event-stream');
			// responseHeaders.set('Transfer-Encoding', 'chunked');
			// responseHeaders.set('Cache-Control', 'no-cache');
			// responseHeaders.set('Connection', 'keep-alive');

			return new Response(transformedBody, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: responseHeaders,
			});
		}
	} catch (e: any) {
		console.error('Error forwarding request to Google API:', e);
		// CodeAssistServer might return errors with a 'response' property containing status and data
		if (e.response && e.response.status) {
			return c.json({ error: 'Google API error', details: e.response.data }, e.response.status);
		} else {
			return c.json({ error: 'Failed to forward request to Google API', details: e.message }, 500);
		}
	}
});


export default app;


import { OAuth2Client } from "google-auth-library";
import { Protocol, ProviderHandler, OpenAIRequest, GeminiRequest, AnthropicRequest, Credential, ThrottledError, ApiKeyWithProvider, GeminiRequestBody, RequestContext } from "../../core/types";
import { convertOpenAiRequestToGemini, convertGeminiResponseToOpenAi, GeminiToOpenAiSseTransformer } from "../../adapters/openai-gemini";
import { handleAnthropicRequestWithAdapter } from "../../utils/adapter-utils";

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';

/**
 * A TransformStream that intercepts Server-Sent Events (SSE) from the
 * Google Code Assist API and unwraps the nested `response` object to match
 * the standard Gemini API format.
 */
class CodeAssistUnwrapTransformer implements Transformer<Uint8Array, Uint8Array> {
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
			console.error('[CodeAssistUnwrapTransformer] Unprocessed buffer remaining at the end of the stream:', this.buffer);
			controller.enqueue(this.encoder.encode(this.buffer));
		}
	}
}

class GeminiCodeAssistHandler implements ProviderHandler {
	supportedProtocols(): Protocol[] {
		return [Protocol.OpenAI, Protocol.Gemini, Protocol.Anthropic];
	}

	canAccessModelWithKey(apiKey: ApiKeyWithProvider, model: string): boolean {
		return true;
	}

	/**
	 * Intelligently parses the keyData from an ApiKey.
	 * It supports both legacy Base64 encoded JSON and native JSON objects.
	 * @param keyData The keyData from the ApiKey model.
	 * @returns The parsed credentials object with tokens and projectId.
	 */
	private parseKeyData(keyData: any): { tokens: any; projectId: string } {
		if (typeof keyData === 'object' && keyData !== null) {
			// Handle {"key": "<base64 string>"} format
			if (typeof keyData.key === 'string') {
				try {
					const decodedString = Buffer.from(keyData.key, 'base64').toString('utf-8');
					return JSON.parse(decodedString);
				} catch (e) {
					throw new Error('Failed to parse base64 encoded key from keyData.key');
				}
			}
			// Handle direct JSON object format
			return keyData as { tokens: any; projectId: string };
		}
		throw new Error('Unsupported keyData format.');
	}

	async checkAndGetAccessToken(cred: Credential): Promise<{ accessToken: string; projectId: string } | Error> {
		const key = cred.apiKey;
		// Extract tokens and projectId from keyData
		const { tokens, projectId } = this.parseKeyData(key.keyData);
		// Handle OAuth token refresh if applicable
		let accessToken = tokens.access_token;
		const client = new OAuth2Client({
			clientId: OAUTH_CLIENT_ID,
			clientSecret: OAUTH_CLIENT_SECRET,
		});
		client.setCredentials(tokens);
		try {
			await client.getAccessToken(); // Refreshes the token
		} catch (e: any) {
			if (e.response?.data?.error === 'invalid_grant') {
				console.error(`Permanent failure for ApiKey ${key.id} (invalid_grant): ${e.message}`);
				cred.feedback.recordApiKeyPermanentlyFailed(key); // Report permanent failure
				return new Error(`ApiKey ${key.id} is permanently failed.`);
			}
			console.error(`Error refreshing token for ApiKey ${key.id}:`, e);
			return new Error(`Error refreshing token for ApiKey ${key.id}: ${e.message}`);
		}
		const refreshedCredentials = client.credentials;
		if (refreshedCredentials.access_token !== tokens.access_token) {
			// Update keyData with refreshed tokens
			key.keyData = {
				tokens: {
					refresh_token: refreshedCredentials.refresh_token,
					expiry_date: refreshedCredentials.expiry_date,
					access_token: refreshedCredentials.access_token,
					token_type: refreshedCredentials.token_type,
					id_token: refreshedCredentials.id_token,
					scope: refreshedCredentials.scope,
				},
				projectId,
			};
			accessToken = refreshedCredentials.access_token;
			cred.feedback.recordKeyDataUpdated(key); // Report key data updated
		}
		return { accessToken, projectId };
	}

	async sendRequestToGeminiCodeAssist(cred: Credential, model: string, requestBody: GeminiRequestBody, sse: boolean, method?: string): Promise<Response | Error> {
		method = method ?? (sse ? 'streamGenerateContent' : 'generateContent');

		const key = cred.apiKey;
		const checkResult = await this.checkAndGetAccessToken(cred);
		if (checkResult instanceof Error) {
			return checkResult;
		}
		const { accessToken, projectId } = checkResult;

		try {
			const response = await this.forwardRequest(accessToken, projectId, model, method, requestBody, sse);

			if (response.status === 429) {
				const message = await response.text();
				console.log(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
				return new ThrottledError(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
			}

			return response;
		} catch (e: any) {
			console.error('Error during forwardRequest:', e);
			return new Error(`Error during forwardRequest: ${e.message}`);
		}
	}

	// Helper function to forward requests to the Google API
	async forwardRequest(accessToken: string, projectId: string, model: string, method: string, requestBody: any, sse?: boolean): Promise<Response> {
		const version = process.env.CLI_VERSION || process.version;
		const userAgent = `GeminiCLI/${version} (${process.platform}; ${process.arch})`;

		const body = {
			model: model,
			project: projectId,
			request: requestBody,
		};

		const headers = new Headers();
		headers.append('Content-Type', 'application/json');
		headers.append('User-Agent', userAgent);
		headers.append('Authorization', `Bearer ${accessToken}`);

		const url = new URL(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`);
		if (sse) {
			url.searchParams.set('alt', 'sse');
		}

		return fetch(url, {
			method: "POST",
			headers: headers,
			body: JSON.stringify(body),
		});
	}

	// Helper function to process the response from Google API for OpenAI compatibility
	async processUpstreamResponseOpenAI(upstreamResponse: Response, model: string, stream: boolean, includeUsage: boolean): Promise<Response> {
		if (!upstreamResponse.ok) {
			return upstreamResponse; // Pass through error responses directly.
		}

		if (stream) {
			if (!upstreamResponse.body) {
				return new Response('Upstream response has no body', { status: 500 });
			}
			const unwrapStream = new TransformStream(new CodeAssistUnwrapTransformer());
			const openAiTransformStream = new TransformStream(new GeminiToOpenAiSseTransformer(model, includeUsage));

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
			const openAIResponse = convertGeminiResponseToOpenAi(respObj, model);
			return new Response(JSON.stringify(openAIResponse), {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// Helper function to process the response from Google API
	async processUpstreamResponseGemini(sse: boolean, upstreamResponse: Response): Promise<Response> {
		if (!upstreamResponse.ok) {
			return upstreamResponse; // Pass through error responses directly.
		}

		if (sse) {
			if (!upstreamResponse.body) {
				return new Response('Upstream response has no body', { status: 500 });
			}
			const transformStream = new TransformStream(new CodeAssistUnwrapTransformer());
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
			return new Response(JSON.stringify(respObj), {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleOpenAIRequest(ctx: RequestContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error> {
		const geminiReq = convertOpenAiRequestToGemini(request);
		const response = await this.sendRequestToGeminiCodeAssist(cred, geminiReq.model, geminiReq.request, geminiReq.sse, geminiReq.method);
		if (response instanceof Error) {
			return response;
		}
		if (response.ok) {
			const includeUsage = request.stream_options?.include_usage ?? false;
			return this.processUpstreamResponseOpenAI(response, geminiReq.model, geminiReq.sse, includeUsage);
		}
		return response;
	}

	async handleGeminiRequest(ctx: RequestContext, request: GeminiRequest, cred: Credential): Promise<Response | Error> {
		const response = await this.sendRequestToGeminiCodeAssist(cred, request.model, request.request, request.sse, request.method);
		if (response instanceof Error) {
			return response;
		}
		if (response.ok) {
			return this.processUpstreamResponseGemini(request.sse, response);
		}
		return response;
	}

	async handleAnthropicRequest(ctx: RequestContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error> {
		return handleAnthropicRequestWithAdapter(ctx, request, cred, this.handleOpenAIRequest.bind(this));
	}
}

export const geminiCodeAssistHandler = new GeminiCodeAssistHandler();

import { ExecutionContext, Protocol, ProviderHandler, OpenAIRequest, GeminiRequest, AnthropicRequest, Credential, ThrottledError, ApiKeyWithProvider, GeminiRequestBody } from "../../core/types";
import { convertOpenAiRequestToGemini, convertGeminiResponseToOpenAi, GeminiToOpenAiSseTransformer } from "../../adapters/openai-gemini";

const GOOGLE_AI_STUDIO_ENDPOINT = 'https://generativelanguage.googleapis.com';
const GOOGLE_AI_STUDIO_API_VERSION = 'v1beta';


class GoogleAIStudioHandler implements ProviderHandler {
	supportedProtocols(): Protocol[] {
		return [Protocol.OpenAI, Protocol.Gemini];
	}

	canAccessModelWithKey(apiKey: ApiKeyWithProvider, model: string): boolean {
		return true;
	}

	/**
	 * Parses the keyData from an ApiKey.
	 * For Google AI Studio, this should be a simple API key string.
	 * @param keyData The keyData from the ApiKey model.
	 * @returns The API key string.
	 */
	private parseKeyData(keyData: any): string {
		if (typeof keyData === 'string') {
			return keyData;
		}

		if (typeof keyData === 'object' && keyData !== null) {
			// Handle {"key": "<api_key_string>"} format
			if (typeof keyData.key === 'string') {
				return keyData.key;
			}
		}

		throw new Error('Unsupported keyData format. Expected a string API key.');
	}

	async sendRequestToGoogleAIStudio(ctx: ExecutionContext, cred: Credential, model: string, requestBody: GeminiRequestBody, sse: boolean, method?: string): Promise<Response | Error> {
		method = method ?? (sse ? 'streamGenerateContent' : 'generateContent');

		const key = cred.apiKey;
		let apiKey: string;

		try {
			apiKey = this.parseKeyData(key.keyData);
		} catch (e: any) {
			console.error(`Error parsing API key for ApiKey ${key.id}:`, e.message);
			await cred.feedback.reportApiKeyStatus(key, false, false, false, true, ctx); // Report permanent failure
			return new Error(`ApiKey ${key.id} has invalid format: ${e.message}`);
		}

		let isRateLimited = false;
		let success = false;

		try {
			const response = await this.forwardRequest(apiKey, model, method, requestBody, sse);

			if (response.status === 429) {
				isRateLimited = true;
				const message = await response.text();
				console.log(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
				return new ThrottledError(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
			} else if (response.ok) {
				success = true;
			} else {
				console.log(`Response is not ok, status: ${response.status} ${response.statusText}`);
			}
			return response;
		} catch (e: any) {
			console.error('Error during forwardRequest:', e);
			// Assume all forwardRequest errors are not rate limits, but other failures
			success = false;
			return new Error(`Error during forwardRequest: ${e.message}`);
		} finally {
			// Report API call result to throttleHelper
			await cred.feedback.reportApiKeyStatus(key, success, isRateLimited, false, false, ctx);
		}
	}

	// Helper function to forward requests to the Google API
	async forwardRequest(apiKey: string, model: string, method: string, requestBody: any, sse?: boolean): Promise<Response> {
		const headers = new Headers();
		headers.append('Content-Type', 'application/json');
		headers.append('x-goog-api-key', `${apiKey}`);

		const url = new URL(`${GOOGLE_AI_STUDIO_ENDPOINT}/${GOOGLE_AI_STUDIO_API_VERSION}/models/${model}:${method}`);
		if (sse) {
			url.searchParams.set('alt', 'sse');
		}

		return fetch(url, {
			method: "POST",
			headers: headers,
			body: JSON.stringify(requestBody),
		});
	}

	// Helper function to process the response from Google AI Studio for OpenAI compatibility
	async processUpstreamResponseOpenAI(upstreamResponse: Response, model: string, stream: boolean, includeUsage: boolean): Promise<Response> {
		if (!upstreamResponse.ok) {
			return upstreamResponse; // Pass through error responses directly.
		}

		if (stream) {
			if (!upstreamResponse.body) {
				return new Response('Upstream response has no body', { status: 500 });
			}

			const openAiTransformStream = new TransformStream(new GeminiToOpenAiSseTransformer(model, includeUsage));
			const transformedBody = upstreamResponse.body.pipeThrough(openAiTransformStream);

			const responseHeaders = new Headers(upstreamResponse.headers);
			responseHeaders.set('Content-Type', 'text/event-stream');
			return new Response(transformedBody, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: responseHeaders,
			});
		} else {
			const respObj: any = await upstreamResponse.json();
			const openAIResponse = convertGeminiResponseToOpenAi(respObj, model);
			return new Response(JSON.stringify(openAIResponse), {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleOpenAIRequest(ctx: ExecutionContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error> {
		const geminiReq = convertOpenAiRequestToGemini(request);
		const response = await this.sendRequestToGoogleAIStudio(ctx, cred, geminiReq.model, geminiReq.request, geminiReq.sse, geminiReq.method);
		if (response instanceof Error) {
			return response;
		}
		if (response.ok) {
			const includeUsage = request.stream_options?.include_usage ?? false;
			return this.processUpstreamResponseOpenAI(response, geminiReq.model, geminiReq.sse, includeUsage);
		}
		return response;
	}

	async handleGeminiRequest(ctx: ExecutionContext, request: GeminiRequest, cred: Credential): Promise<Response | Error> {
		const response = await this.sendRequestToGoogleAIStudio(ctx, cred, request.model, request.request, request.sse);
		if (response instanceof Error) {
			return response;
		}
		// For Gemini protocol, we can pass through the response directly since it's already in Gemini format
		return response;
	}

	async handleAnthropicRequest(ctx: ExecutionContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error> {
		return new Error("Method not implemented. Anthropic protocol is not supported.");
	}
}

export const googleAIStudioHandler = new GoogleAIStudioHandler();

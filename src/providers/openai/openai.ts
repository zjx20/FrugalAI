import { RequestContext, Protocol, ProviderHandler, OpenAIRequest, GeminiRequest, AnthropicRequest, Credential, ThrottledError, ApiKeyWithProvider } from "../../core/types";
import { handleAnthropicRequestWithAdapter } from "../../utils/adapter-utils";

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';

class OpenAIHandler implements ProviderHandler {
	supportedProtocols(): Protocol[] {
		// Only support OpenAI and Anthropic protocols
		// Gemini protocol is not supported because there's no Gemini -> OpenAI adapter
		return [Protocol.OpenAI, Protocol.Anthropic];
	}

	canAccessModelWithKey(apiKey: ApiKeyWithProvider, model: string): boolean {
		// No model restrictions for OPEN_AI provider
		return true;
	}

	/**
	 * Parses the keyData from an ApiKey.
	 * For OPEN_AI provider, this should be a simple API key string.
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

	/**
	 * Gets the base URL for the OpenAI endpoint.
	 * Uses custom baseUrl if provided, otherwise defaults to official OpenAI endpoint.
	 */
	private getBaseUrl(apiKey: ApiKeyWithProvider): string {
		if (apiKey.baseUrl) {
			// Remove trailing slash if present
			return apiKey.baseUrl.replace(/\/$/, '');
		}
		return DEFAULT_OPENAI_ENDPOINT;
	}

	/**
	 * Forwards request to OpenAI-compatible endpoint.
	 */
	async forwardRequest(baseUrl: string, apiKey: string, endpoint: string, requestBody: any): Promise<Response> {
		const headers = new Headers();
		headers.append('Content-Type', 'application/json');
		headers.append('Authorization', `Bearer ${apiKey}`);

		const url = `${baseUrl}${endpoint}`;

		return fetch(url, {
			method: "POST",
			headers: headers,
			body: JSON.stringify(requestBody),
		});
	}

	async handleOpenAIRequest(ctx: RequestContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error> {
		const key = cred.apiKey;
		let apiKey: string;

		try {
			apiKey = this.parseKeyData(key.keyData);
		} catch (e: any) {
			console.error(`Error parsing API key for ApiKey ${key.id}:`, e.message);
			cred.feedback.recordApiKeyPermanentlyFailed(key); // Report permanent failure
			return new Error(`ApiKey ${key.id} has invalid format: ${e.message}`);
		}

		const baseUrl = this.getBaseUrl(key);

		try {
			const response = await this.forwardRequest(baseUrl, apiKey, '/chat/completions', request);

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

	async handleGeminiRequest(ctx: RequestContext, request: GeminiRequest, cred: Credential): Promise<Response | Error> {
		return new Error("Gemini protocol is not supported by OPEN_AI provider.");
	}

	async handleAnthropicRequest(ctx: RequestContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error> {
		return handleAnthropicRequestWithAdapter(ctx, request, cred, this.handleOpenAIRequest.bind(this));
	}
}

export const openAIHandler = new OpenAIHandler();

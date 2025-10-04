import { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import {
	Content,
	GenerateContentConfig,
	SafetySetting,
	Tool,
	ToolConfig,
} from '@google/genai';
import { ApiKey, Provider, User } from '../generated/prisma';
import { ApiKeyFeedback } from './throttle-helper';

export interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
	props: any;
}

export type OpenAIRequest = ChatCompletionCreateParams;

type GeminiGenerationConfig = Omit<GenerateContentConfig,
	'tools' | 'toolConfig' | 'safetySettings' |
	'systemInstruction' | 'cachedContent' |
	'httpOptions' | 'abortSignal'
>;

export type GeminiRequest = {
	model: string,
	method: string,
	sse: boolean,
	request: {
		contents: Content[],
		tools?: Tool[],
		toolConfig?: ToolConfig,
		safetySettings?: SafetySetting[],
		systemInstruction?: Content,
		generationConfig?: GeminiGenerationConfig,
		cachedContent?: string,
	}
};

// TODO: define AnthropicRequest
export type AnthropicRequest = any;

export enum Protocol {
	OpenAI = 'openai',
	Gemini = 'gemini',
	Anthropic = 'anthropic',
}

export interface ProviderHandler {
	/**
	 * Returns the list of API protocols supported by the provider.
	 */
	supportedProtocols(): Protocol[];

	/**
	 * Validates whether the given API key is eligible to invoke the specified model.
	 *
	 * Important:
	 * - At the time this method is called, the model has ALREADY been verified as supported by the provider
	 *   (e.g., via provider-level supported model lists or upstream routing checks).
	 * - This method should NOT determine provider-wide model support. Instead, it should decide per-key eligibility.
	 *
	 * Implementation guidance:
	 * - Use the provider metadata attached to the ApiKey (e.g., plan/tier, region, quotas, feature flags)
	 *   to determine whether this specific key can access the model.
	 * - Example: A key on a "pro" plan may access higher-tier models, while a "basic" plan cannot.
	 * - Return false for keys that do not meet the required plan/tier, region, quota, or feature flags.
	 * - Avoid performing network calls; this should be a synchronous compatibility check.
	 *
	 * @param apiKey The API key record including provider metadata (plan/tier, region, quotas, flags).
	 * @param model The already-provider-supported model identifier (e.g., "gpt-4o-mini", "gemini-1.5-pro").
	 * @returns True if this API key is authorized/eligible to call the model; otherwise false.
	 */
	canAccessModelWithKey(apiKey: ApiKeyWithProvider, model: string): boolean;

	/**
	 * Handles a request using the OpenAI API protocol.
	 * @param ctx The execution context from the environment.
	 * @param request The request object, conforming to OpenAI's standards.
	 * @param cred The credential to use for the request, including the API key and feedback mechanism.
	 * @throws {Error} If the provider does not support the OpenAI protocol.
	 * @returns A promise that resolves to the Response object.
	 */
	handleOpenAIRequest(ctx: ExecutionContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error>;

	/**
	 * Handles a request using the Gemini API protocol.
	 * @param ctx The execution context from the environment.
	 * @param request The request object, conforming to Gemini's standards.
	 * @param cred The credential to use for the request, including the API key and feedback mechanism.
	 * @throws {Error} If the provider does not support the Gemini protocol.
	 * @returns A promise that resolves to the Response object.
	 */
	handleGeminiRequest(ctx: ExecutionContext, request: GeminiRequest, cred: Credential): Promise<Response | Error>;

	/**
	 * Handles a request using the Anthropic API protocol.
	 * @param ctx The execution context from the environment.
	 * @param request The request object, conforming to Anthropic's standards.
	 * @param cred The credential to use for the request, including the API key and feedback mechanism.
	 * @throws {Error} If the provider does not support the Anthropic protocol.
	 * @returns A promise that resolves to the Response object.
	 */
	handleAnthropicRequest(ctx: ExecutionContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error>;
}

export type ApiKeyWithProvider = ApiKey & { provider: Provider };

export type UserWithKeys = User & { keys: ApiKeyWithProvider[] };

export type Credential = {
	apiKey: ApiKeyWithProvider;
	feedback: ApiKeyFeedback;
};

export class ThrottledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ThrottledError';
	}
}

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
	 * Checks if the provider can handle a given model.
	 * @param modelName The name of the model to check.
	 * @returns True if the model is supported, false otherwise.
	 */
	canHandleModel(modelName: string): Promise<boolean>;

	/**
	 * Returns the list of API protocols supported by the provider.
	 */
	supportedProtocols(): Protocol[];

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

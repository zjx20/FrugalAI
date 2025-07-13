import { ChatCompletionCreateParams, ChatCompletion, ChatCompletionChunk, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { CompletionUsage } from 'openai/resources/completions';
import {
	Content,
	FunctionCallingConfigMode,
	FinishReason,
	GenerateContentParameters,
	GenerateContentResponse,
	MediaResolution,
	MediaModality,
	Tool,
} from '@google/genai';

function defined(v: any): boolean {
	return v !== undefined && v !== null;
}

export function convertChatCompletionCreateToGemini(
	req: ChatCompletionCreateParams,
): GenerateContentParameters {
	const gReq: GenerateContentParameters = {
		model: req.model,
		contents: [],
		config: {},
	};

	const result = convertOpenAiMessagesToGemini(req.messages);
	gReq.contents = result.geminiContents;
	if (result.systemInstructions.length > 0) {
		const systemInstructions: Content = {
			parts: [],
		};
		for (const instruction of result.systemInstructions) {
			systemInstructions.parts!.push({ text: instruction });
		}
		gReq.config!.systemInstruction = systemInstructions;
	}
	if (result.imageDetails.length > 0) {
		let mediaResolution: MediaResolution | undefined = undefined;
		// detail?: 'auto' | 'low' | 'high';
		for (const detail of result.imageDetails) {
			switch (detail) {
				case 'auto':
					mediaResolution = undefined;
					break;
				case 'low':
					mediaResolution = MediaResolution.MEDIA_RESOLUTION_LOW;
					break;
				case 'high':
					mediaResolution = MediaResolution.MEDIA_RESOLUTION_HIGH;
					break;
			}
		}
		if (mediaResolution) {
			gReq.config!.mediaResolution = mediaResolution;
		}
	}

	// TODO: req.audio (can map to gReq.speechConfig, but not easy)

	if (defined(req.frequency_penalty)) {
		gReq.config!.frequencyPenalty = req.frequency_penalty!;
	}

	if (defined(req.tool_choice)) {
		switch (req.tool_choice!) {
			case 'none':
				gReq.config!.toolConfig = {
					functionCallingConfig: {
						mode: FunctionCallingConfigMode.NONE,
					},
				};
				break;
			case 'auto':
				gReq.config!.toolConfig = {
					functionCallingConfig: {
						mode: FunctionCallingConfigMode.AUTO,
					},
				};
				break;
			case 'required':
				gReq.config!.toolConfig = {
					functionCallingConfig: {
						mode: FunctionCallingConfigMode.ANY,
					},
				};
				break;
			default:
				if (req.tool_choice!.type === 'function') {
					gReq.config!.toolConfig = {
						functionCallingConfig: {
							mode: FunctionCallingConfigMode.ANY,
							allowedFunctionNames: [req.tool_choice!.function.name],
						},
					};
				}
				break;
		}
	} else if (defined(req.function_call)) {
		// Note: req.function_call is deprecated, in favor of req.tool_choice
		if (req.function_call === 'none') {
			gReq.config!.toolConfig = {
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.NONE,
				},
			};
		} else if (req.function_call === 'auto') {
			gReq.config!.toolConfig = {
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.AUTO,
				},
			};
		} else if (defined(req.function_call!.name)) {
			gReq.config!.toolConfig = {
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.ANY,
					allowedFunctionNames: [req.function_call!.name],
				},
			};
		}
	}

	if (req.tools) {
		const tools: Tool[] = [];
		for (const t of req.tools) {
			if (t.type === 'function') {
				tools.push({
					// TODO: t.strict is ignored
					functionDeclarations: [
						{
							name: t.function.name,
							description: t.function.description,
							parameters: t.function.parameters,
						}
					],
				});
			}
		}
		gReq.config!.tools = tools;
	} else if (req.functions) {
		// Note: req.functions is deprecated, in favor of req.tools
		const tools: Tool[] = [];
		for (const f of req.functions) {
			tools.push({
				functionDeclarations: [
					{
						name: f.name,
						description: f.description,
						parameters: f.parameters,
					}
				],
			});
		}
		gReq.config!.tools = tools;
	}

	// TODO: req.logit_bias (no such functionality in Gemini)

	if (!!req.logprobs) {
		gReq.config!.responseLogprobs = req.logprobs;
		if (defined(req.top_logprobs)) {
			gReq.config!.logprobs = req.top_logprobs!;
		}
	}

	if (defined(req.max_completion_tokens)) {
		gReq.config!.maxOutputTokens = req.max_completion_tokens!;
	} else if (defined(req.max_tokens)) {
		gReq.config!.maxOutputTokens = req.max_tokens!;
	}

	if (defined(req.metadata)) {
		gReq.config!.labels = req.metadata as Record<string, string>;
	}

	if (defined(req.modalities)) {
		gReq.config!.responseModalities = req.modalities as string[];
	}

	if (defined(req.n)) {
		gReq.config!.candidateCount = req.n!;
	}

	// TODO: req.parallel_tool_calls (enabled by default in Gemini, cannot disable)
	// TODO: req.prediction (no such functionality in Gemini)

	if (defined(req.presence_penalty)) {
		gReq.config!.presencePenalty = req.presence_penalty!;
	}

	if (defined(req.reasoning_effort)) {
		// https://ai.google.dev/gemini-api/docs/openai#thinking
		let budget: number = -1;
		switch (req.reasoning_effort!) {
			case 'low':
				budget = 1024;
				break;
			case 'medium':
				budget = 8192;
				break;
			case 'high':
				budget = 24576;
				break;
		}
		gReq.config!.thinkingConfig = {
			thinkingBudget: budget,
		};
	}

	if (defined(req.response_format)) {
		switch (req.response_format!.type) {
			case 'text':
				gReq.config!.responseMimeType = 'text/plain';
				break;
			case 'json_object':
				gReq.config!.responseMimeType = 'application/json';
				break;
			case 'json_schema':
				gReq.config!.responseMimeType = 'application/json';
				gReq.config!.responseSchema = req.response_format!.json_schema;
				break;
		}
	}

	if (defined(req.seed)) {
		gReq.config!.seed = req.seed!;
	}

	// TODO: req.service_tier (no such functionality in Gemini)

	if (defined(req.stop)) {
		gReq.config!.stopSequences = Array.isArray(req.stop!)
			? req.stop!
			: [req.stop!];
	}

	// TODO: req.store (no such functionality in Gemini)
	// Note: req.stream and req.stream_options.include_usage should be handled outside

	if (defined(req.temperature)) {
		gReq.config!.temperature = req.temperature!;
	}

	if (defined(req.top_p)) {
		gReq.config!.topP = req.top_p!;
	}

	// TODO: req.user (no such functionality in Gemini)

	if (defined(req.web_search_options)) {
		req.web_search_options!.search_context_size
		if (!gReq.config!.tools) {
			gReq.config!.tools = [];
		}
		gReq.config!.tools.push({ googleSearchRetrieval: {} });
	}

	return gReq;
}

export declare interface OpenAiMessagesConversionResult {
	geminiContents: Content[];
	systemInstructions: string[];
	imageDetails: string[];
}

/**
 * Converts an array of OpenAI-formatted messages to Google's `contents` format.
 *
 * - Merges consecutive messages from the same role.
 * - Maps roles: 'assistant' -> 'model', 'user' -> 'user'.
 * - Handles 'system' messages by prepending them to the next user message.
 * - Handles 'tool' messages by converting them to `functionCall` and `functionResponse` parts.
 *
 * @param messages The array of OpenAI messages.
 * @returns An array of Google `Content` objects.
 */
export function convertOpenAiMessagesToGemini(
	messages: ChatCompletionCreateParams['messages'],
): OpenAiMessagesConversionResult {
	const geminiContents: Content[] = [];
	const systemInstructions: string[] = [];
	const imageDetails: string[] = [];
	const toolCalls: Record<string, string> = {};  // tool_call_id => tool_name

	for (const message of messages) {
		if (message.role === 'system' || message.role === 'developer') {
			if (typeof message.content === 'string') {
				systemInstructions.push(message.content);
			} else if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === 'text') {
						systemInstructions.push(part.text);
						continue;
					}
				}
			}
			continue;
		}

		if (message.role === 'user') {
			const content: Content = {
				role: 'user',
				parts: [],
			};
			if (typeof message.content === 'string') {
				content.parts!.push({ text: message.content });
			} else if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === 'text') {
						content.parts!.push({ text: part.text });
					} else if (part.type === 'image_url') {
						const url = part.image_url.url;
						// Handle data URIs by extracting mimeType and base64 data
						if (url.startsWith('data:')) {
							const [header, data] = url.split(',');
							const mimeType = header.split(':')[1].split(';')[0];
							content.parts!.push({
								inlineData: {
									mimeType,
									data,
								},
							});
						} else {
							// Note: the mimeType is required
							// TODO: guess mimeType by url path
							content.parts!.push({
								fileData: {
									fileUri: part.image_url.url,
									mimeType: 'application/octet-stream',
								},
							});
						}
						if (part.image_url.detail) {
							imageDetails.push(part.image_url.detail);
						}
					} else if (part.type === 'input_audio') {
						let mimeType = 'application/octet-stream';
						if (part.input_audio.format === 'mp3') {
							mimeType = 'audio/mpeg';
						} else if (part.input_audio.format === 'wav') {
							mimeType = 'audio/wav';
						}
						content.parts!.push({
							inlineData: {
								data: part.input_audio.data,
								mimeType,
							},
						});
					} else if (part.type === 'file') {
						if (defined(part.file.file_data)) {
							content.parts!.push({
								inlineData: {
									data: part.file.file_data,
									mimeType: 'application/octet-stream',
									displayName: part.file.filename,
								},
							});
						}
						// Note: not support part.file.file_id
					}
				}
			}
			if (content.parts!.length > 0) {
				geminiContents.push(content);
			}
			continue;
		}

		if (message.role === 'assistant') {
			const content: Content = {
				role: 'model',
				parts: [],
			};
			if (message.content) {
				if (typeof message.content === 'string') {
					content.parts!.push({ text: message.content });
				} else {
					// It's an array of content parts
					for (const part of message.content) {
						if (part.type === 'text') {
							content.parts!.push({ text: part.text });
						}
						if (part.type === 'refusal') {
							content.parts!.push({ text: part.refusal });
						}
					}
				}
			}
			if (message.refusal) {
				content.parts!.push({ text: message.refusal });
			}
			if (message.tool_calls) {
				for (const tc of message.tool_calls) {
					if (tc.type === 'function') {
						let args: any = undefined;
						if (tc.function.arguments) {
							try {
								args = JSON.parse(tc.function.arguments);
							} catch (e) {
								console.error('Failed to parse function arguments:', e, ', tool call ignored:', JSON.stringify(tc.function));
								continue;
							}
						}
						toolCalls[tc.id] = tc.function.name;
						content.parts!.push({
							functionCall: {
								id: tc.id,
								name: tc.function.name,
								args: args,
							},
						});
					}
				}
			}
			if (message.function_call) {
				// Handle deprecated function_call
				let ignore: boolean = false;
				let args: any = undefined;
				if (message.function_call.arguments) {
					try {
						args = JSON.parse(message.function_call.arguments);
					} catch (e) {
						console.error('Failed to parse function call arguments:', e, ', function call ignored:', JSON.stringify(message.function_call));
						ignore = true;
					}
				}
				if (!ignore) {
					content.parts!.push({
						functionCall: {
							name: message.function_call.name,
							args: args,
						},
					});
				}
			}

			// Note: message.audio is ignored

			if (content.parts!.length > 0) {
				geminiContents.push(content);
			}
			continue;
		}

		if (message.role === 'tool') {
			const toolName = toolCalls[message.tool_call_id];
			if (!toolName) {
				console.error("Ignore tool call response because the name of the tool cannot be found in previous messages, message:", JSON.stringify(message));
				continue;
			}
			const content: Content = {
				role: 'user',
				parts: [{
					functionResponse: {
						id: message.tool_call_id,
						name: toolName,
						response: {
							// message.content is not a JSON in OpenAI api
							content: message.content,
						},
					},
				}],
			};
			geminiContents.push(content);
			continue;
		}

		// Note: function message is deprecated
		if (message.role === 'function') {
			const content: Content = {
				role: 'user',
				parts: [{
					functionResponse: {
						name: message.name,
						response: {
							// message.content is not a JSON in OpenAI api
							content: message.content,
						},
					},
				}],
			};
			geminiContents.push(content);
			continue;
		}
	}

	return {
		geminiContents,
		systemInstructions,
		imageDetails,
	};
}

class OpenAiCompletionUsage {
	private readonly completionUsage: CompletionUsage = {
		completion_tokens: 0,
		prompt_tokens: 0,
		total_tokens: 0,
	};

	countFor(googleChunk: GenerateContentResponse) {
		if (!googleChunk.usageMetadata) {
			return;
		}
		const usage = googleChunk.usageMetadata;
		this.completionUsage.completion_tokens += usage.candidatesTokenCount || 0;
		this.completionUsage.prompt_tokens += usage.promptTokenCount || 0;
		this.completionUsage.total_tokens += usage.totalTokenCount || 0;

		for (const detail of (usage.candidatesTokensDetails || [])) {
			if (detail.modality === MediaModality.AUDIO) {
				if (!this.completionUsage.completion_tokens_details) {
					this.completionUsage.completion_tokens_details = {
						audio_tokens: 0,
					};
				}
				this.completionUsage.completion_tokens_details!.audio_tokens! += detail.tokenCount || 0;
			}
		}
		if (usage.thoughtsTokenCount) {
			if (!this.completionUsage.completion_tokens_details) {
				this.completionUsage.completion_tokens_details = {};
			}
			this.completionUsage.completion_tokens_details!.reasoning_tokens = usage.thoughtsTokenCount;
		}
		for (const detail of (usage.promptTokensDetails || [])) {
			if (!this.completionUsage.prompt_tokens_details) {
				if (detail.modality === MediaModality.AUDIO) {
					this.completionUsage.prompt_tokens_details = {
						audio_tokens: 0,
					};
					this.completionUsage.prompt_tokens_details!.audio_tokens! += detail.tokenCount || 0;
				}
			}
		}
		if (usage.cachedContentTokenCount) {
			if (!this.completionUsage.prompt_tokens_details) {
				this.completionUsage.prompt_tokens_details = {};
			}
			this.completionUsage.prompt_tokens_details!.cached_tokens = usage.cachedContentTokenCount;
		}
	}

	toChunk(streamId: string, model: string, createTime?: number): ChatCompletionChunk {
		return {
			id: streamId,
			object: 'chat.completion.chunk',
			created: Math.floor(createTime || Date.now() / 1000),
			model: model,
			choices: [], // Usage chunk has an empty choices array
			usage: this.completionUsage,
		};
	}
}

/**
 * Transforms a Google Gemini API response chunk (SSE) to an OpenAI-compatible
 * Chat Completion chunk.
 */
export class GoogleToOpenAiSseTransformer implements Transformer<Uint8Array, Uint8Array> {
	private buffer = '';
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private readonly completionUsage: OpenAiCompletionUsage = new OpenAiCompletionUsage();
	private readonly model: string;
	private readonly includeUsage: boolean;
	private readonly streamId: string;

	private createTime?: number;
	private done: boolean = false;

	constructor(model: string, includeUsage: boolean = false) {
		this.model = model;
		this.streamId = `chatcmpl-${crypto.randomUUID()}`;
		this.includeUsage = includeUsage;
	}

	transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
		this.buffer += this.decoder.decode(chunk, { stream: true });

		// Google's API uses `\r\n\r\n` as a delimiter for SSE events.
		const eventStrings = this.buffer.split('\r\n\r\n');
		this.buffer = eventStrings.pop() || ''; // Keep the last, possibly incomplete, event in the buffer.

		for (const eventString of eventStrings) {
			if (!eventString.startsWith('data: ')) {
				continue;
			}

			const jsonString = eventString.substring(6);
			if (jsonString === '[DONE]') {
				// Note: The Gemini server typically does not send a "[DONE]" event like this.
				this.sendDone(controller);
				continue;
			}

			try {
				const googleChunk: GenerateContentResponse = JSON.parse(jsonString);
				const openAiChunk = convertCompletionChunk(this.streamId, this.model, googleChunk);
				if (openAiChunk) {
					this.createTime = openAiChunk.created;
					const sseString = `data: ${JSON.stringify(openAiChunk)}\n\n`;
					controller.enqueue(this.encoder.encode(sseString));
				} else {
					console.error(`Failed to convert chunk to OpenAI format: ${jsonString}`);
				}
				if (googleChunk.usageMetadata) {
					this.completionUsage.countFor(googleChunk);
				}
			} catch (e) {
				console.error('Failed to parse or transform SSE chunk:', e, jsonString);
			}
		}
	}

	flush(controller: TransformStreamDefaultController<Uint8Array>) {
		if (this.buffer) {
			// Normally, the server adds a delimiter after the last event,
			// so there should be no unprocessed buffer at the end.
			console.error('[GoogleToOpenAiSseTransformer] Unprocessed buffer remaining at the end of the stream:', this.buffer);
		}
		this.sendDone(controller);
	}

	private sendDone(controller: TransformStreamDefaultController<Uint8Array>) {
		if (this.done) {
			return;
		}
		if (this.includeUsage) {
			const usageChunk = this.completionUsage.toChunk(this.streamId, this.model, this.createTime);
			controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
		}
		controller.enqueue(this.encoder.encode('data: [DONE]\n\n'));
		this.done = true;
	}
}

function convertCompletionChunk(streamId: string, model: string, googleChunk: GenerateContentResponse): ChatCompletionChunk | null {
	if (!googleChunk.candidates || googleChunk.candidates.length === 0) {
		return null;
	}

	const openaiChunk: ChatCompletionChunk = {
		id: streamId,
		choices: [],
		created: Math.floor(new Date(googleChunk.createTime || new Date()).getTime() / 1000),
		model: model,
		object: 'chat.completion.chunk',
	};

	let idx = 0;
	for (const cand of googleChunk.candidates) {
		if (!cand.content || !cand.content.parts || cand.content.parts.length === 0) {
			continue;
		}
		let text: string | undefined = undefined;
		let toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined = undefined;
		for (const part of cand.content.parts) {
			if (part.text) {
				let partText = part.text || '';
				if (part.thought) {
					partText = `<thinking>${partText}</thinking>`;
				}
				text = text ? text + partText : partText;
			} else if (part.functionCall) {
				if (toolCalls === undefined) {
					toolCalls = [];
				}
				toolCalls.push({
					index: 0,
					id: part.functionCall.id,
					type: 'function',
					function: {
						name: part.functionCall.name,
						arguments: part.functionCall.args ? JSON.stringify(part.functionCall.args) : undefined,
					},
				});
			}
		}
		const choice: ChatCompletionChunk.Choice = {
			index: idx++,
			delta: {
				role: 'assistant',
				content: text,
				tool_calls: toolCalls,
			},
			finish_reason: cand.finishReason ? mapFinishReason(cand.finishReason) : null,
			// logprobs: null,  // can't be mapped from cand.logprobsResult
		};

		openaiChunk.choices.push(choice);
	}

	if (openaiChunk.choices.length === 0) {
		return null;
	}

	return openaiChunk;
}

/**
 * Converts a full Google Gemini API response to an OpenAI-compatible
 * Chat Completion response.
 */
export function convertGoogleResponseToOpenAi(googleResponse: GenerateContentResponse, model: string): ChatCompletion {
	const openaiChunk = convertCompletionChunk('', model, googleResponse);
	if (!openaiChunk) {
		throw new Error(`Cannot convert Gemini API response to OpenAI format: ${JSON.stringify(googleResponse)}`);
	}
	const usage = new OpenAiCompletionUsage();
	usage.countFor(googleResponse);
	const usageChunk = usage.toChunk('', '');

	const choices: ChatCompletion.Choice[] = [];
	for (const chunkChoice of openaiChunk.choices) {
		let toolCalls: ChatCompletionMessageToolCall[] | undefined = undefined;
		if (chunkChoice.delta.tool_calls && chunkChoice.delta.tool_calls.length > 0) {
			toolCalls = [];
			for (const toolCall of chunkChoice.delta.tool_calls) {
				if (!toolCall.function) {
					continue;
				}
				const toolCallMessage: ChatCompletionMessageToolCall = {
					id: toolCall.id || '',
					type: 'function',
					function: {
						name: toolCall.function.name || '',
						arguments: toolCall.function.arguments ? toolCall.function.arguments : '',
					},
				};
				toolCalls.push(toolCallMessage);
			}
		}

		const choice: ChatCompletion.Choice = {
			finish_reason: chunkChoice.finish_reason || 'stop',
			index: chunkChoice.index,
			message: {
				content: chunkChoice.delta.content || null,
				refusal: null,
				role: 'assistant',
				tool_calls: toolCalls,
			},
			logprobs: null,
		};
		choices.push(choice);
	}

	return {
		id: `chatcmpl-${crypto.randomUUID()}`,
		choices: choices,
		created: openaiChunk.created,
		model: openaiChunk.model,
		object: 'chat.completion',
		usage: usageChunk.usage || undefined,
	};
}

function mapFinishReason(reason: FinishReason): ChatCompletionChunk.Choice['finish_reason'] {
	switch (reason) {
		case 'STOP':
			return 'stop';
		case 'MAX_TOKENS':
			return 'length';
		default:
			return 'content_filter';
	}
}

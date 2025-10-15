import { ContentBlock, Message, MessageParam, StopReason } from "@anthropic-ai/sdk/resources";
import { ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent, MessageDeltaEvent, MessageStartEvent, MessageStopEvent, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicRequest, OpenAIRequest } from "../core/types";
import { ChatCompletion, ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionContentPartText, ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources";
import { Stream } from "openai/streaming";

export const AnthropicApiVersion = '2023-06-01';

export function convertAnthropicRequestToOpenAI(
	req: AnthropicRequest,
): OpenAIRequest {

	const openaiReq: OpenAIRequest = {
		messages: [],
		model: req.model,
		...(req.stream ? { stream: true } : {})
	};

	if (req.system) {
		// TODO: whether to use the developer role?
		if (typeof req.system === 'string') {
			openaiReq.messages.push({
				role: 'system',
				content: req.system,
			});
		} else if (Array.isArray(req.system)) {
			let text = '';
			for (const part of req.system) {
				if (part.type === 'text') {
					text += part.text;
				}
			}
			if (text) {
				openaiReq.messages.push({
					role: 'system',
					content: text,
				});
			}
		} else {
			console.warn(`unconvertible system message type: ${typeof req.system}`);
		}
	}

	const convertedMessages = convertAnthropicMessagesToOpenAI(req.messages) || [];
	openaiReq.messages.push(...convertedMessages);

	// openaiReq.max_tokens = req.max_tokens; // deprecated
	openaiReq.max_completion_tokens = req.max_tokens;

	if (req.metadata) {
		openaiReq.metadata = {};
		for (const [key, value] of Object.entries(req.metadata)) {
			if (value !== undefined && value !== null) {
				if (typeof value === 'string') {
					openaiReq.metadata[key] = value;
				} else {
					openaiReq.metadata[key] = JSON.stringify(value);
				}
			}
		}
	}

	if (req.thinking && req.thinking.type === 'enabled') {
		// Note: The threshold values used for this mapping are arbitrary.
		const budget = req.thinking.budget_tokens;
		if (budget <= 256) {
			openaiReq.reasoning_effort = 'minimal';
		} else if (budget <= 512) {
			openaiReq.reasoning_effort = 'low';
		} else if (budget <= 2048) {
			openaiReq.reasoning_effort = 'medium';
		} else {
			openaiReq.reasoning_effort = 'high';
		}
	}

	if (req.service_tier) {
		switch (req.service_tier) {
			case 'auto':
				openaiReq.service_tier = 'auto';
				break;
			case 'standard_only':
				openaiReq.service_tier = 'default';
				break;
			default:
				openaiReq.service_tier = 'auto';
		}
	}

	if (req.stop_sequences) {
		openaiReq.stop = req.stop_sequences;
	}

	// TODO: whether to set openaiReq.stream_options.include_usage

	if (req.temperature !== undefined) {
		openaiReq.temperature = req.temperature;
	}

	if (req.tool_choice) {
		let parallel_tool_calls = true;
		switch (req.tool_choice.type) {
			case 'auto':
				openaiReq.tool_choice = 'auto';
				parallel_tool_calls = !req.tool_choice.disable_parallel_tool_use;
				break;
			case 'any':
				openaiReq.tool_choice = 'required';
				parallel_tool_calls = !req.tool_choice.disable_parallel_tool_use;
				break;
			case 'tool':
				openaiReq.tool_choice = {
					type: 'function',
					function: { name: req.tool_choice.name },
				};
				parallel_tool_calls = !req.tool_choice.disable_parallel_tool_use;
				break;
			case 'none':
				openaiReq.tool_choice = 'none';
				break;
			default:
			// For other cases, let OpenAI handle the default.
		}
		if (!parallel_tool_calls) {
			openaiReq.parallel_tool_calls = false;
		}
	}

	if (req.tools) {
		openaiReq.tools = [];
		for (const tool of req.tools) {
			switch (tool.type) {
				case undefined: // fall through
				case 'custom':
					openaiReq.tools.push({
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.input_schema,
							strict: true,
						},
					});
					break;
				case 'bash_20250124':
					// Doc: https://docs.claude.com/en/docs/agents-and-tools/tool-use/bash-tool
					// This schema is expanded with detailed operational semantics for broader model compatibility.
					// Operations:
					// - Execute command: Run a shell command in the persistent bash session by providing the "command" parameter.
					// - Restart session: Restart the bash session to clear all state by setting "restart" to true.
					openaiReq.tools.push({
						type: 'function',
						function: {
							name: 'bash',
							description:
								`Bash tool to execute shell commands in a persistent session. Schema:
- Operations:
  - Execute command: Run a shell command in the persistent bash session. Provide "command" parameter with the shell command to execute.
  - Restart session: Restart the bash session to clear all state (environment variables, working directory, etc.). Set "restart" to true.
- Parameters object:
  - command: string. The bash command to run. Required unless using restart operation.
  - restart: boolean. Optional. Set to true to restart the bash session and clear all state. Defaults to false.
- Session behavior:
  - Maintains persistent state between commands (environment variables, working directory, installed packages).
  - Commands execute in sequence within the same session.
  - Use restart to clear session state when needed.
- Use cases:
  - Development workflows: Run build commands, tests, development tools (e.g., "npm run build", "pytest").
  - System automation: Execute scripts, manage files, automate tasks (e.g., "ls -la", "mkdir project").
  - Data processing: Process files, run analysis scripts (e.g., "grep pattern file.txt", "wc -l *.csv").
  - Environment setup: Install packages, configure environments (e.g., "pip install requests").`,
							parameters: {
								type: 'object',
								properties: {
									command: {
										type: 'string',
										description: 'The bash command to run. Required unless using restart operation.'
									},
									restart: {
										type: 'boolean',
										description: 'Set to true to restart the bash session and clear all state (environment variables, working directory, etc.). Defaults to false.',
										default: false
									}
								},
								required: ['command']
							},
							strict: true,
						}
					});
					break;
				case 'text_editor_20250728':
				// Doc: https://docs.claude.com/en/docs/agents-and-tools/tool-use/text-editor-tool
				// Claude 4 text editor tool (July 28, 2025). Matches 20250429 capabilities plus an Anthropic-only "max_characters" parameter.
				// Note: "max_characters" for partial views cannot be represented in the OpenAI function tool mapping and is deliberately ignored.

				// fallthough
				case 'text_editor_20250429':
					// Claude 4 text editor tool (April 29, 2025). Identical capabilities to Sonnet 3.7's text editor minus undo_edit.
					// This schema is expanded with detailed command semantics for broader model compatibility.
					// Commands:
					// - view: Read a file or list a directory at "path". For files, optionally pass "view_range" [start, end] (1-indexed; -1 for end means EOF).
					// - str_replace: Replace exact occurrences of "old_str" with "new_str" in the file at "path". Match must be exact, including whitespace and indentation.
					// - create: Create a new file at "path" with "file_text" as its full contents.
					// - insert: Insert "new_str" after line "insert_line" in the file at "path" (0 inserts at beginning of file).
					openaiReq.tools.push({
						type: 'function',
						function: {
							name: 'str_replace_based_edit_tool',
							description:
								`Text editor tool to view and modify text files. Schema:
- Commands:
  - view: Read a file or list a directory at "path". For files, optionally pass "view_range" [start_line, end_line] (1-indexed; -1 for end means EOF).
  - str_replace: Replace exact occurrences of "old_str" with "new_str" in the file at "path". Match must be exact, including whitespace and indentation.
  - create: Create a new file at "path" with "file_text" as its full contents.
  - insert: Insert "new_str" after line "insert_line" in the file at "path" (0 inserts at beginning of file).
- Parameters object:
  - command: string enum ["view","str_replace","create","insert"].
  - path: string. Target file or directory path. Required for all commands.
  - view_range: optional [start_line, end_line] for command=view on files; 1-indexed; -1 end_line means EOF; not applicable for directories.
  - old_str: string. Required for command=str_replace: exact text to replace (must match including whitespace/indentation).
  - new_str: string. For command=str_replace: replacement text. For command=insert: the text to insert.
  - file_text: string. Required for command=create: full content to write to the new file.
  - insert_line: integer. For command=insert: line number after which to insert text. 0 inserts at beginning of file.`,
							parameters: {
								type: 'object',
								properties: {
									command: {
										type: 'string',
										description: 'The editor command to run. See command-specific parameters below.',
										enum: ['view', 'str_replace', 'create', 'insert']
									},
									path: {
										type: 'string',
										description: 'Target file or directory path. Required for all commands.'
									},
									view_range: {
										type: 'array',
										description: 'Optional for command=view on files: [start_line, end_line], 1-indexed. Use -1 for end_line to read to EOF. Not applicable when path is a directory.',
										minItems: 2,
										maxItems: 2,
										items: { type: 'integer' }
									},
									old_str: {
										type: 'string',
										description: 'Required for command=str_replace: the exact text to replace (must match including whitespace/indentation).'
									},
									new_str: {
										type: 'string',
										description: 'For command=str_replace: replacement text. For command=insert: the text to insert.'
									},
									file_text: {
										type: 'string',
										description: 'Required for command=create: full content to write to the new file.'
									},
									insert_line: {
										type: 'integer',
										description: 'For command=insert: line number after which to insert text. 0 inserts at beginning of file.'
									}
								},
								required: ['command', 'path']
							},
							strict: true,
						}
					});
					break;
				case 'text_editor_20250124':
					// Claude Sonnet 3.7 text editor tool. Includes undo_edit (host should maintain backups).
					// This schema is expanded with detailed command semantics so non-Claude models can use it effectively.
					// Commands:
					// - view: Read a file or list a directory at "path". For files, optionally pass "view_range" [start, end] (1-indexed; -1 for end means EOF).
					// - str_replace: Replace exact occurrences of "old_str" with "new_str" in the file at "path". Match must be exact, including whitespace and indentation.
					// - create: Create a new file at "path" with "file_text" as its full contents.
					// - insert: Insert "new_str" after line "insert_line" in the file at "path" (0 inserts at beginning of file).
					// - undo_edit: Revert the last edit to the file at "path". Host must maintain backups for this to succeed.
					openaiReq.tools.push({
						type: 'function',
						function: {
							name: 'str_replace_editor',
							description:
								`Text Editor schema:
- Commands:
  - view: Read a file or list a directory at "path". For files, optionally pass "view_range" [start_line, end_line] (1-indexed; -1 for end means EOF).
  - str_replace: Replace exact occurrences of "old_str" with "new_str" in the file at "path". Match must be exact, including whitespace and indentation.
  - create: Create a new file at "path" with "file_text" as its full contents.
  - insert: Insert "new_str" after line "insert_line" in the file at "path" (0 inserts at beginning of file).
  - undo_edit: Revert the last edit to the file at "path". Host must maintain backups for this to succeed.
- Parameters object:
  - command: string enum ["view","str_replace","create","insert","undo_edit"].
  - path: string. Target file or directory path. Required for all commands.
  - view_range: optional [start_line, end_line] for command=view on files; 1-indexed; -1 end_line means EOF; not applicable for directories.
  - old_str: string. Required for command=str_replace: exact text to replace (must match including whitespace/indentation).
  - new_str: string. For command=str_replace: replacement text. For command=insert: the text to insert.
  - file_text: string. Required for command=create: full content to write to the new file.
  - insert_line: integer. For command=insert: line number after which to insert text. 0 inserts at beginning of file.
Notes:
- Includes undo_edit. The host must maintain per-file backups to enable successful undo operations.`,
							parameters: {
								type: 'object',
								properties: {
									command: {
										type: 'string',
										description: 'The editor command to run. See command-specific parameters below.',
										enum: ['view', 'str_replace', 'create', 'insert', 'undo_edit']
									},
									path: {
										type: 'string',
										description: 'Target file or directory path. Required for all commands.'
									},
									view_range: {
										type: 'array',
										description: 'Optional for command=view on files: [start_line, end_line], 1-indexed. Use -1 for end_line to read to EOF. Not applicable when path is a directory.',
										minItems: 2,
										maxItems: 2,
										items: { type: 'integer' }
									},
									old_str: {
										type: 'string',
										description: 'Required for command=str_replace: the exact text to replace (must match including whitespace/indentation).'
									},
									new_str: {
										type: 'string',
										description: 'For command=str_replace: replacement text. For command=insert: the text to insert.'
									},
									file_text: {
										type: 'string',
										description: 'Required for command=create: full content to write to the new file.'
									},
									insert_line: {
										type: 'integer',
										description: 'For command=insert: line number after which to insert text. 0 inserts at beginning of file.'
									}
								},
								required: ['command', 'path']
							},
							strict: true,
						}
					});
					break;
				case 'web_search_20250305':
					// Note: The web_search tool is executed by Anthropic API, not the client.
					openaiReq.web_search_options = {};
					if (tool.user_location) {
						if (tool.user_location.type === 'approximate') {
							openaiReq.web_search_options.user_location = {
								type: 'approximate',
								approximate: {
									city: tool.user_location.city || undefined,
									country: tool.user_location.country || undefined,
									region: tool.user_location.region || undefined,
									timezone: tool.user_location.timezone || undefined,
								},
							}
						}
					}
					// Domain filtering is only available in the Responses API with the web_search tool.
					// So tool.allowed_domains and other fields are ignored.
					break;

				default:
					console.warn(`Unknown Anthropic tool type: ${tool.type}`);
					break;
			}
		}
	}

	// TODO: OpenAI don't support top_k

	if (req.top_p !== undefined) {
		openaiReq.top_p = req.top_p;
	}

	return openaiReq;
}

function convertAnthropicMessagesToOpenAI(messages: MessageParam[]): ChatCompletionMessageParam[] {
	const openaiMsgs: ChatCompletionMessageParam[] = [];
	for (const message of messages) {
		if (typeof message.content === 'string') {
			openaiMsgs.push({
				role: message.role,
				content: message.content,
			});
			continue
		}
		if (!Array.isArray(message.content)) {
			console.warn(`unconvertible message content type: ${typeof message.content}`);
			continue;
		}

		const textParts: ChatCompletionContentPartText[] = [];
		const contentParts: ChatCompletionContentPart[] = [];
		const toolCalls: ChatCompletionMessageToolCall[] = [];
		for (const contentBlock of message.content) {
			if (contentBlock.type === 'text') {
				const textPart: ChatCompletionContentPartText = { type: 'text', text: contentBlock.text };
				textParts.push(textPart);
				contentParts.push(textPart);
				continue;
			}
			if (contentBlock.type === 'image') {
				let image_url = undefined;
				if (contentBlock.source.type === 'url') {
					image_url = contentBlock.source.url;
				} else if (contentBlock.source.type === 'base64') {
					image_url = `data:${contentBlock.source.media_type};base64,${contentBlock.source.data}`;
				} else {
					console.warn(`unconvertible image source type: ${(contentBlock.source as any).type}`)
				}
				if (image_url) {
					contentParts.push({
						type: 'image_url',
						image_url: { url: image_url },
					});
				}
				continue;
			}
			if (contentBlock.type === 'document') {
				let base64_content = undefined;
				if (contentBlock.source.type === 'base64') {
					base64_content = contentBlock.source.data;
				} else if (contentBlock.source.type === 'text') {
					base64_content = Buffer.from(contentBlock.source.data).toString('base64');
				} else if (contentBlock.source.type === 'content') {
					if (typeof contentBlock.source.content === 'string') {
						base64_content = Buffer.from(contentBlock.source.content).toString('base64');
					} else {
						console.warn(`unconvertible document content type: ${typeof contentBlock.source.content}`);
					}
				} else {
					console.warn(`unconvertible document source type: ${(contentBlock.source as any).type}`)
				}
				if (base64_content) {
					contentParts.push({
						type: 'file',
						file: {
							file_data: base64_content,
							filename: contentBlock.title || undefined,
						}
					});
				}
				continue;
			}
			if (contentBlock.type === 'redacted_thinking') {
				// This part is ignored as it is not human-readable and is for Claude's internal use.
				continue;
			}
			if (contentBlock.type === 'thinking') {
				// https://docs.claude.com/en/docs/build-with-claude/extended-thinking
				// Note: The reasoning content is preserved, although there is not a standard for it.
				openaiMsgs.push({
					role: message.role,
					content: contentBlock.thinking,
				});
				continue;
			}
			if (contentBlock.type === 'tool_result') {
				const msg: ChatCompletionToolMessageParam = {
					role: 'tool',
					tool_call_id: contentBlock.tool_use_id,
					content: '',
				};
				if (typeof contentBlock.content === 'string') {
					msg.content = contentBlock.content;
				} else if (Array.isArray(contentBlock.content)) {
					const parts: ChatCompletionContentPartText[] = [];
					for (const cpart of contentBlock.content) {
						if (cpart.type === 'text') {
							parts.push(cpart);
						} else {
							// No idea how to convert other types
							console.warn(`unconvertible tool content block part type: ${cpart.type}`);
						}
					}
					msg.content = parts;
				}
				openaiMsgs.push(msg);
				continue;
			}
			if (contentBlock.type === 'tool_use') {
				toolCalls.push({
					type: 'function',
					id: contentBlock.id,
					function: {
						name: contentBlock.name,
						arguments: JSON.stringify(contentBlock.input),
					},
				});
				continue;
			}
			if (contentBlock.type === 'search_result') {
				// Note: This conversion is an approximation and may not be accurate.
				// openaiMsgs.push({
				// 	role: message.role,
				// 	content: (contentBlock.content || []).concat([
				// 		{type: 'text', text: `<title>${contentBlock.title}</title>`},
				// 		{type: 'text', text: `<source>${contentBlock.source}</source>`},
				// 	]),
				// });
				// continue;
			}
			if (contentBlock.type === 'server_tool_use') {
				// Note: This conversion is an approximation and may not be accurate.
				// openaiMsgs.push({
				// 	role: message.role,
				// 	content: `<server_tool_use><name>${contentBlock.name}</name><id>${contentBlock.id}</id><input>${JSON.stringify(contentBlock.input)}</input></server_tool_use>`,
				// });
				// continue;
			}
			if (contentBlock.type === 'web_search_tool_result') {
				// TODO:
			}

			console.warn(`unconvertible message content block type: ${contentBlock.type}`);
		}
		if (message.role === 'assistant') {
			if (textParts.length > 0 || toolCalls.length > 0) {
				openaiMsgs.push({
					role: 'assistant',
					content: textParts,
					tool_calls: toolCalls,
				});
			}
			if ((contentParts.length - textParts.length) > 0) {
				// ChatCompletionAssistantMessageParam does not accept image or file parts.
				console.warn(`message content contains image or file parts (${contentParts.map(p => p.type).join(', ')}), which are not accepted by assistant messages.`);
			}
		} else if (message.role === 'user') {
			if (contentParts.length > 0) {
				openaiMsgs.push({
					role: 'user',
					content: contentParts,
				});
			}
			if (toolCalls.length > 0) {
				console.warn(`message contains tool calls, which are not accepted by user messages.`);
			}
		} else {
			console.warn(`unconvertible message role: ${message.role}`);
		}
	}

	return openaiMsgs;
}

export async function convertOpenAIResponseToAnthropic(stream: boolean, response: Response, ctx?: ExecutionContext): Promise<Response> {
	if (!stream) {
		if (!response.ok) {
			// Pass through error responses directly
			const body = await response.text();
			return new Response(body, {
				status: response.status,
				headers: response.headers,
			});
		}
		const completion: ChatCompletion = await response.json();
		const message = convertChatCompletionToMessage(completion);

		return new Response(JSON.stringify(message), {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'anthropic-version': AnthropicApiVersion,
				'request-id': response.headers.get('x-request-id') || completion.id || '',
			}
		});
	}

	// Handle streaming response
	const controller = new AbortController();
	const openaiStream = Stream.fromSSEResponse<ChatCompletionChunk>(response, controller);

	let _resolveReturnSignal: (() => void) | null = null;
	const returnSignal = new Promise<void>((resolve) => { _resolveReturnSignal = resolve; });
	const resolveReturnSignal = () => {
		if (_resolveReturnSignal !== null) {
			_resolveReturnSignal();
			_resolveReturnSignal = null;
		}
	};

	// Create a TransformStream to convert OpenAI chunks to Anthropic SSE events
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	// Process the stream asynchronously
	const pumpPromise = (async () => {
		try {
			for await (const sseData of convertOpenAIStreamToAnthropicSSE(openaiStream)) {
				// console.log(`debug: converted anthropic event:\n${sseData}\n`);
				resolveReturnSignal();
				await writer.write(encoder.encode(sseData));
			}
			await writer.close();
		} catch (error) {
			controller.abort();
			await writer.abort(error);
		} finally {
			resolveReturnSignal();
		}
	})();

	// In Cloudflare Workers, extend the script's lifetime to ensure the stream processing completes.
	if (ctx?.waitUntil) {
		ctx.waitUntil(pumpPromise);
	}
	// Delay returning the response until the first SSE event is sent or a timeout occurs, to extend the worker's lifetime.
	const timeoutMs = 5000;
	try {
		await Promise.race([
			returnSignal,
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	} catch (_) {
		// ignore
	}

	return new Response(readable, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'anthropic-version': AnthropicApiVersion
		}
	});
}

function convertChatCompletionToMessage(completion: ChatCompletion): Message {
	const choice = completion.choices?.[0];
	if (!choice) {
		throw new Error('Invalid OpenAI response: "choices" array is empty or missing.');
	}
	const message = choice.message;

	// Build content blocks
	const content: ContentBlock[] = [];

	// Handle text content
	if (message.content !== null) {
		content.push({
			type: 'text',
			text: message.content,
			citations: null,
		});
	}

	// `reasoning_content` is a non-standard field, originally introduced by DeepSeek-R1, that has gained widespread adoption.
	if ((message as any).reasoning_content) {
		content.push({
			type: 'thinking',
			thinking: (message as any).reasoning_content,
			signature: '',
		});
	}

	// Handle tool calls
	if (message.tool_calls && message.tool_calls.length > 0) {
		for (const toolCall of message.tool_calls) {
			// Only handle function tool calls, not custom tool calls
			if (toolCall.type === 'function') {
				let input: any = toolCall.function.arguments;
				try {
					input = JSON.parse(toolCall.function.arguments);
				} catch (e) {
					// ignore
				}
				content.push({
					type: 'tool_use',
					id: toolCall.id,
					name: toolCall.function.name,
					input: input
				});
			}
		}
	}

	// Build Anthropic Message
	const anthropicMessage: Message = {
		id: completion.id,
		type: 'message',
		role: 'assistant',
		content: content,
		model: completion.model,
		stop_reason: mapFinishReasonToStopReason(choice.finish_reason),
		stop_sequence: null,
		usage: {
			cache_creation: null,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			input_tokens: completion.usage?.prompt_tokens || 0,
			output_tokens: completion.usage?.completion_tokens || 0,
			server_tool_use: null,
			service_tier: 'standard',
		}
	};

	return anthropicMessage;
}

function mapFinishReasonToStopReason(
	finishReason: ChatCompletion.Choice['finish_reason'] | null
): StopReason {
	switch (finishReason) {
		case 'stop':
			return 'end_turn';
		case 'length':
			return 'max_tokens';
		case 'function_call':
			return 'tool_use';
		case 'tool_calls':
			return 'tool_use';
		case 'content_filter':
			return 'refusal';
		default:
			return 'end_turn';
	}
}

async function* convertOpenAIStreamToAnthropicSSE(
	openaiStream: AsyncIterable<ChatCompletionChunk>
): AsyncGenerator<string> {
	let messageId: string | null = null;
	let model: string | null = null;
	let currentToolCallId: string | null = null;
	let currentToolName: string | null = null;
	let contentBlockIndex = 0;
	let hasStartedTextBlock = false;
	let hasStartedThinkingBlock = false;
	let hasStartedToolBlock = false;
	let inputTokens = 0;
	let outputTokens = 0;

	const buildContentBlockStopEvent = () => {
		const event: ContentBlockStopEvent = {
			type: 'content_block_stop',
			index: contentBlockIndex,
		};
		contentBlockIndex++;
		return event;
	};

	const buildSignatureDeltaEvent = () => {
		const event: ContentBlockDeltaEvent = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: {
				type: 'signature_delta',
				signature: '',
			}
		};
		return event;
	};

	for await (const chunk of openaiStream) {
		// console.log(`debug: original openai event:\n${JSON.stringify(chunk, null, 2)}\n`);

		// Initialize message on first chunk
		if (!messageId) {
			messageId = chunk.id;
			model = chunk.model;

			// Send message_start event
			const messageStart: MessageStartEvent = {
				type: 'message_start',
				message: {
					id: messageId,
					type: 'message',
					role: 'assistant',
					content: [],
					model: model,
					stop_reason: null,
					stop_sequence: null,
					usage: {
						cache_creation: null,
						cache_creation_input_tokens: null,
						cache_read_input_tokens: null,
						input_tokens: 0,
						output_tokens: 0,
						server_tool_use: null,
						service_tier: 'standard',
					}
				}
			};
			yield formatSSE('message_start', messageStart);
		}

		const delta = chunk.choices[0]?.delta;
		if (!delta) {
			continue;
		}

		// Handle text content
		if (delta.content) {
			// Stop started blocks
			if (hasStartedThinkingBlock) {
				yield formatSSE('content_block_delta', buildSignatureDeltaEvent());
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedThinkingBlock = false;
			}
			if (hasStartedToolBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedToolBlock = false;
			}

			// Start text block if not already started
			if (!hasStartedTextBlock) {
				const blockStart: ContentBlockStartEvent = {
					type: 'content_block_start',
					index: contentBlockIndex,
					content_block: {
						type: 'text',
						text: '',
						citations: null,
					}
				};
				yield formatSSE('content_block_start', blockStart);
				hasStartedTextBlock = true;
			}

			// Send text delta
			const blockDelta: ContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: contentBlockIndex,
				delta: {
					type: 'text_delta',
					text: delta.content
				}
			};
			yield formatSSE('content_block_delta', blockDelta);
		}
		// Handling thinking content
		else if ((delta as any).reasoning_content) {
			// Stop started blocks
			if (hasStartedTextBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedTextBlock = false;
			}
			if (hasStartedToolBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedToolBlock = false;
			}

			// Start thinking block if not already started
			if (!hasStartedThinkingBlock) {
				const blockStart: ContentBlockStartEvent = {
					type: 'content_block_start',
					index: contentBlockIndex,
					content_block: {
						type: 'thinking',
						thinking: '',
						signature: '',
					}
				};
				yield formatSSE('content_block_start', blockStart);
				hasStartedThinkingBlock = true;
			}

			// Send text delta
			const blockDelta: ContentBlockDeltaEvent = {
				type: 'content_block_delta',
				index: contentBlockIndex,
				delta: {
					type: 'thinking_delta',
					thinking: (delta as any).reasoning_content,
				}
			};
			yield formatSSE('content_block_delta', blockDelta);
		}
		// Handle tool calls
		else if (delta.tool_calls && delta.tool_calls.length > 0) {
			// Stop started blocks
			if (hasStartedTextBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedTextBlock = false;
			}
			if (hasStartedThinkingBlock) {
				yield formatSSE('content_block_delta', buildSignatureDeltaEvent());
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedThinkingBlock = false;
			}

			// OpenAI doc: https://platform.openai.com/docs/guides/function-calling#streaming
			// Example:
			//   [{"index": 0, "id": "call_DdmO9pD3xa9XTPNJ32zg2hcA", "function": {"arguments": "", "name": "get_weather"}, "type": "function"}]
			//   [{"index": 0, "id": null, "function": {"arguments": "{\"", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": "location", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": "\":\"", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": "Paris", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": ",", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": " France", "name": null}, "type": null}]
			//   [{"index": 0, "id": null, "function": {"arguments": "\"}", "name": null}, "type": null}]

			// Anthropic doc: https://docs.claude.com/en/docs/build-with-claude/streaming#streaming-request-with-tool-use

			for (const toolCall of delta.tool_calls) {
				// New tool call starting
				if (toolCall.id) {
					// Close previous tool block if any
					if (hasStartedToolBlock) {
						yield formatSSE('content_block_stop', buildContentBlockStopEvent());
						hasStartedToolBlock = false;
					}

					currentToolCallId = toolCall.id;
					currentToolName = toolCall.function?.name || '';

					// Start new tool use block
					const blockStart: ContentBlockStartEvent = {
						type: 'content_block_start',
						index: contentBlockIndex,
						content_block: {
							type: 'tool_use',
							id: currentToolCallId,
							name: currentToolName,
							input: {}
						}
					};
					yield formatSSE('content_block_start', blockStart);
					hasStartedToolBlock = true;
				}

				// Accumulate tool arguments
				if (toolCall.function?.arguments) {
					// Send input_json_delta
					const blockDelta: ContentBlockDeltaEvent = {
						type: 'content_block_delta',
						index: contentBlockIndex,
						delta: {
							type: 'input_json_delta',
							partial_json: toolCall.function.arguments
						}
					};
					yield formatSSE('content_block_delta', blockDelta);
				}
			}
		}

		// Handle usage information if available
		if (chunk.usage) {
			if (chunk.usage.prompt_tokens) {
				inputTokens = chunk.usage.prompt_tokens;
			}
			if (chunk.usage.completion_tokens) {
				outputTokens = chunk.usage.completion_tokens;
			}
		}

		// Check for completion
		const finishReason = chunk.choices[0]?.finish_reason;
		if (finishReason) {
			// Close current content block
			if (hasStartedThinkingBlock) {
				yield formatSSE('content_block_delta', buildSignatureDeltaEvent());
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedThinkingBlock = false;
			}
			if (hasStartedTextBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedTextBlock = false;
			}
			if (hasStartedToolBlock) {
				yield formatSSE('content_block_stop', buildContentBlockStopEvent());
				hasStartedToolBlock = false;
			}

			// Send message_delta with stop_reason and usage
			const messageDelta: MessageDeltaEvent = {
				type: 'message_delta',
				delta: {
					stop_reason: mapFinishReasonToStopReason(finishReason),
					stop_sequence: null
				},
				usage: {
					cache_creation_input_tokens: null,
					cache_read_input_tokens: null,
					input_tokens: 0,
					// Note: `input_tokens` should ideally be sent in the `message_start` event. However, the OpenAI
					// protocol does not provide the input token count at that stage. This can lead to some client
					// applications reporting an unusually low token count. To provide a more reasonable-looking usage
					// statistic for such clients, we are summing `inputTokens` and `outputTokens` here. Be aware that
					// this will result in inaccurate cost calculations, as input and output tokens are typically priced
					// differently.
					output_tokens: inputTokens + outputTokens,
					server_tool_use: null,
				}
			};
			yield formatSSE('message_delta', messageDelta);

			// Send message_stop
			const messageStop: MessageStopEvent = {
				type: 'message_stop'
			};
			yield formatSSE('message_stop', messageStop);
			break;
		}
	}
}

function formatSSE(event: RawMessageStreamEvent['type'], data: any): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

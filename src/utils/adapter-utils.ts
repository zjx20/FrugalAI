import { AnthropicRequest, Credential, OpenAIRequest, RequestContext } from '../core/types';
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic } from '../adapters/anthropic-openai';
import { ExecutionContext } from 'hono';

/**
 * A generic handler that adapts a request to the OpenAI protocol, sends it,
 * and then converts the response back to the original protocol.
 *
 * @param ctx The request context.
 * @param request The original request object (e.g., AnthropicRequest).
 * @param cred The credential object.
 * @param handleOpenAIRequest The provider's method for handling OpenAI-compatible requests.
 * @param requestConverter A function to convert the original request to an OpenAIRequest.
 * @param responseConverter A function to convert the OpenAI Response back to the original format.
 * @param getStream A function to determine if the request is a streaming request.
 * @returns A promise that resolves to a Response or an Error.
 */
export async function handleRequestWithAdapter<T_REQ>(
	ctx: RequestContext,
	request: T_REQ,
	cred: Credential,
	handleOpenAIRequest: (ctx: RequestContext, request: OpenAIRequest, cred: Credential) => Promise<Response | Error>,
	requestConverter: (req: T_REQ) => OpenAIRequest,
	responseConverter: (stream: boolean, response: Response, execCtx?: ExecutionContext) => Promise<Response>,
	getStream: (req: T_REQ) => boolean,
): Promise<Response | Error> {
	const openaiReq = requestConverter(request);

	// Reuse the existing OpenAI request handler
	const response = await handleOpenAIRequest(ctx, openaiReq, cred);

	// If an error occurred, return it directly
	if (response instanceof Error) {
		return response;
	}

	// If no success, return it directly
	if (!response.ok) {
		return response;
	}

	// Convert OpenAI response back to the original format
	return await responseConverter(
		getStream(request),
		response,
		ctx.executionCtx
	);
}

/**
 * A specific implementation of handleRequestWithAdapter for Anthropic requests.
 *
 * @param ctx The request context.
 * @param request The AnthropicRequest object.
 * @param cred The credential object.
 * @param handleOpenAIRequest The provider's method for handling OpenAI-compatible requests.
 * @returns A promise that resolves to a Response or an Error.
 */
export async function handleAnthropicRequestWithAdapter(
	ctx: RequestContext,
	request: AnthropicRequest,
	cred: Credential,
	handleOpenAIRequest: (ctx: RequestContext, request: OpenAIRequest, cred: Credential) => Promise<Response | Error>,
): Promise<Response | Error> {
	return handleRequestWithAdapter(
		ctx,
		request,
		cred,
		handleOpenAIRequest,
		convertAnthropicRequestToOpenAI,
		convertOpenAIResponseToAnthropic,
		(req) => req.stream || false,
	);
}

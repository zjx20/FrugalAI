import { geminiCodeAssistHandler } from "../gemini/code-assist";
import { ProviderName } from "../generated/prisma";
import { ProviderHandler } from "./types";

export const providerHandlerMap = new Map<ProviderName, ProviderHandler>([
	[ProviderName.GEMINI_CODE_ASSIST, geminiCodeAssistHandler],
]);

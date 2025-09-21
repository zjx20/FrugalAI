import { codeBuddyHandler } from "./codebuddy/codebuddy";
import { geminiCodeAssistHandler } from "./geminicodeassist/code-assist";
import { ProviderName } from "../generated/prisma";
import { ProviderHandler } from "../core/types";

export const providerHandlerMap = new Map<ProviderName, ProviderHandler>([
	[ProviderName.GEMINI_CODE_ASSIST, geminiCodeAssistHandler],
	[ProviderName.CODE_BUDDY, codeBuddyHandler]
]);

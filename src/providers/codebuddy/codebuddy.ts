import { AnthropicRequest, ApiKeyWithProvider, Credential, GeminiRequest, OpenAIRequest, Protocol, ProviderHandler, ThrottledError } from "../../core/types";
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic } from '../../adapters/anthropic-openai';
import crypto from 'crypto';

interface codeBuddyAccount {
	uid: string
}

interface codeBuddyAuthCredential {
	accessToken: string
	refreshToken: string
	expiresIn: number
	refreshExpiresIn: number
	tokenType: string
	expiresAt: number
	refreshExpiresAt: number
	domain: string
}

const codeBuddyVersion = '1.1.4';
const userAgent = `CLI/${codeBuddyVersion} CodeBuddy/${codeBuddyVersion}`;

class CodeBuddyHandler implements ProviderHandler {
	supportedProtocols(): Protocol[] {
		return [Protocol.OpenAI, Protocol.Anthropic];
	}

	canAccessModelWithKey(apiKey: ApiKeyWithProvider, model: string): boolean {
		const codeBuddyModels = ["default-model"]; // International version
		const copilotModels = ["default", "claude-4.5", "claude-4.0"];
		if (!codeBuddyModels.includes(model) && !copilotModels.includes(model)) {
			return true;
		}
		const { auth } = this.parseKeyData(apiKey.keyData);
		if (auth.domain === "www.codebuddy.ai" && codeBuddyModels.includes(model)) {
			return true;
		}
		if (auth.domain === "copilot.tencent.com" && copilotModels.includes(model)) {
			return true;
		}
		return false;
	}

	private parseKeyData(keyData: any): { account: codeBuddyAccount, auth: codeBuddyAuthCredential } {
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
			return keyData;
		}
		throw new Error('Unsupported keyData format.');
	}

	async refreshToken(domain: string, user: string, accessToken: string, refreshToken: string): Promise<Response> {
		const requestId = crypto.randomBytes(16).toString('hex');
		const spanId = crypto.randomBytes(8).toString('hex');

		const headers = new Headers();
		headers.append('Accept', 'application/json');
		headers.append('Content-Type', 'application/json');
		headers.append('X-Requested-With', 'XMLHttpRequest');
		headers.append('X-Refresh-Token', refreshToken);
		headers.append('X-Request-ID', requestId);
		headers.append('b3', `${requestId}-${spanId}-1`);
		headers.append('X-B3-TraceId', requestId);
		headers.append('X-B3-ParentSpanId', '');
		headers.append('X-B3-SpanId', spanId);
		headers.append('X-B3-Sampled', '1');
		headers.append('Authorization', `Bearer ${accessToken}`);
		headers.append('X-User-Id', user);
		headers.append('User-Agent', userAgent);
		headers.append('X-Product', 'SaaS');

		return fetch(`https://${domain}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: headers,
			body: '{}',
		});
	}

	async checkAndGetAccessToken(cred: Credential, forceRefresh: boolean): Promise<{ accessToken: string, domain: string, user: string } | Error> {
		const key = cred.apiKey;
		const { account, auth } = this.parseKeyData(key.keyData);
		let accessToken = auth.accessToken;
		const sevenDays = 7 * 24 * 60 * 60 * 1000;
		if (forceRefresh || Date.now() > auth.expiresAt - sevenDays) {
			try {
				const resp = await this.refreshToken(auth.domain, account.uid, accessToken, auth.refreshToken);
				if (resp.ok) {
					// Update keyData with refreshed tokens
					const respData = await resp.json();
					const newAuth = (respData as any).data as codeBuddyAuthCredential;
					const now = Date.now();
					newAuth.expiresAt = now + newAuth.expiresIn * 1000;
					newAuth.refreshExpiresAt = now + newAuth.refreshExpiresIn * 1000;
					newAuth.domain = auth.domain;
					key.keyData = { account: account, auth: newAuth } as any;
					accessToken = newAuth.accessToken;
					cred.feedback.recordKeyDataUpdated(key); // Report key data updated
				} else if (resp.status === 401) {
					console.error(`Permanent failure for ApiKey ${key.id}, message: ${await resp.text()}`);
					cred.feedback.recordApiKeyPermanentlyFailed(key); // Report permanent failure
					return new Error(`ApiKey ${key.id} is permanently failed.`);
				} else {
					throw new Error(`Unknown error, status: ${resp.status}, message: ${await resp.text()}`);
				}
			} catch (e: any) {
				console.error(`Error refreshing token for ApiKey ${key.id}:`, e);
				return new Error(`Error refreshing token for ApiKey ${key.id}: ${e.message}`);
			}
		}
		return { accessToken: accessToken, domain: auth.domain, user: account.uid };
	}

	async forwardRequest(accessToken: string, domain: string, user: string, requestBody: any): Promise<Response> {
		const conversationId = crypto.randomUUID();
		const requestId = crypto.randomBytes(16).toString('hex');
		const messageId = crypto.randomBytes(16).toString('hex');

		const headers = new Headers();
		headers.append('Accept', 'application/json');
		headers.append('Content-Type', 'application/json');
		headers.append('X-Requested-With', 'XMLHttpRequest');
		headers.append('x-stainless-arch', 'arm64');
		headers.append('x-stainless-lang', 'js');
		headers.append('x-stainless-os', 'MacOS');
		headers.append('x-stainless-package-version', '5.20.3');
		headers.append('x-stainless-retry-count', '0');
		headers.append('x-stainless-runtime', 'node');
		headers.append('x-stainless-runtime-version', 'v21.6.1');
		headers.append('X-Conversation-ID', conversationId);
		headers.append('X-Conversation-Request-ID', requestId);
		headers.append('X-Conversation-Message-ID', messageId);
		headers.append('X-Request-ID', messageId);
		headers.append('X-Agent-Intent', 'craft');
		headers.append('X-IDE-Type', 'CLI');
		headers.append('X-IDE-Name', 'CLI');
		headers.append('X-IDE-Version', codeBuddyVersion);
		headers.append('Authorization', `Bearer ${accessToken}`);
		headers.append('X-User-Id', user);
		headers.append('X-Domain', domain);
		headers.append('User-Agent', userAgent);
		headers.append('X-Product', 'SaaS');

		const url = new URL(`https://${domain}/v2/chat/completions`);
		return fetch(url, {
			method: "POST",
			headers: headers,
			body: JSON.stringify(requestBody),
		});
	}

	private parseResetTime(errorMessage: string): number | null {
		// Example of `errorMessage`:
		//   Chat failed with error: 6005:usage exceeds frequency limit, but don't worry, your usage will reset at 2025-10-16 20:16:42 UTC+8, alternatively, you can switch to the other models to continue using it.

		// "reset at 2025-10-16 20:16:42 UTC+8"
		const match = errorMessage.match(
			/reset at (\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+) UTC([+-])(\d{1,2})/
		);

		if (!match) {
			return null;
		}

		const [, year, month, day, hour, minute, second, sign, offset] = match;

		// ISO 8601 pattern: "2025-10-16T20:16:42+08:00"
		const isoDateString =
			`${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offset.padStart(2, '0')}:00`;

		const timestamp = Date.parse(isoDateString);
		return isNaN(timestamp) ? null : timestamp;
	}

	async handleOpenAIRequest(ctx: ExecutionContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error> {
		var forceRefresh = false;
		var retries = 0;
		while (true) {
			const key = cred.apiKey;
			const checkResult = await this.checkAndGetAccessToken(cred, forceRefresh);
			if (checkResult instanceof Error) {
				return checkResult;
			}
			const { accessToken, domain, user } = checkResult;

			try {
				const response = await this.forwardRequest(accessToken, domain, user, request);

				if (response.status === 429) {
					const message = await response.text();
					const resetTime = this.parseResetTime(message);
					console.log(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
					return new ThrottledError(`ApiKey ${key.id} was rate-limited. Message: ${message}`, resetTime || undefined);
				} else if (response.status === 401) {
					console.log(`Provider ${key.providerName} returns 401 when using ApiKey ${key.id} (${key.notes}).`);
					forceRefresh = true;
					retries++;
					if (retries < 2) {
						continue;
					} else {
						return response;
					}
				}

				return response;
			} catch (e: any) {
				console.error('Error during forwardRequest:', e);
				return new Error(`Error during forwardRequest: ${e.message}`);
			}
		}
	}

	async handleGeminiRequest(ctx: ExecutionContext, request: GeminiRequest, cred: Credential): Promise<Response | Error> {
		return new Error("Method not implemented. Gemini protocol is not supported.");
	}

	async handleAnthropicRequest(ctx: ExecutionContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error> {
		// HACK: The following keywords are part of ClaudeCode's system instruction but are blocked by CodeBuddy's keyword detection, so they are replaced.
		if (request.system) {
			const replacements: [string, string][] = [
				["You are Claude Code, Anthropic's official CLI for Claude.", "You are CodeBuddy, Tencent's official CLI for coding."],
				["Main branch (you will usually use this for PRs)", "Main branch  (you will usually use this for PRs)"],
				["- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", ""],
			];

			const applyReplacements = (text: string): string => {
				let newText = text;
				for (const [search, replace] of replacements) {
					newText = newText.replace(search, replace);
				}
				return newText;
			};

			if (typeof request.system === 'string') {
				request.system = applyReplacements(request.system);
			} else if (Array.isArray(request.system)) {
				request.system.forEach(part => {
					if (part.type === 'text') {
						part.text = applyReplacements(part.text);
					}
				});
			}
		}

		// HACK: CodeBuddy only supports streaming, so `stream` is forcibly set to true.
		// request.stream = true;

		// Convert Anthropic request to OpenAI format
		const openaiRequest = convertAnthropicRequestToOpenAI(request);

		// console.log(`debug: original anthropic request: ${JSON.stringify(request, null, 2)}\n\n`);
		// console.log(`debug: converted openai request: ${JSON.stringify(openaiRequest, null, 2)}\n\n`);

		// Reuse the existing OpenAI request handler
		const response = await this.handleOpenAIRequest(ctx, openaiRequest, cred);

		// If an error occurred, return it directly
		if (response instanceof Error) {
			return response;
		}

		// If no success, return it directly
		if (!response.ok) {
			return response;
		}

		// Convert OpenAI response back to Anthropic format
		return await convertOpenAIResponseToAnthropic(
			request.stream || false,
			response,
			ctx
		);
	}
}

export const codeBuddyHandler = new CodeBuddyHandler();

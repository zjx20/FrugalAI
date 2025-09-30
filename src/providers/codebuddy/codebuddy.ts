import { AnthropicRequest, Credential, GeminiRequest, OpenAIRequest, Protocol, ProviderHandler, ThrottledError } from "../../core/types";
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
		return [Protocol.OpenAI];
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

	async checkAndGetAccessToken(ctx: ExecutionContext, cred: Credential, forceRefresh: boolean): Promise<{ keyDataUpdated: boolean, accessToken: string, domain: string, user: string } | Error> {
		const key = cred.apiKey;
		const { account, auth } = this.parseKeyData(key.keyData);
		let accessToken = auth.accessToken;
		let keyDataUpdated = false;
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
					keyDataUpdated = true;
				} else if (resp.status === 401) {
					console.error(`Permanent failure for ApiKey ${key.id}, message: ${await resp.text()}`);
					await cred.feedback.reportApiKeyStatus(key, false, false, false, true, ctx); // Report permanent failure
					return new Error(`ApiKey ${key.id} is permanently failed.`);
				} else {
					throw new Error(`Unknown error, status: ${resp.status}, message: ${await resp.text()}`);
				}
			} catch (e: any) {
				console.error(`Error refreshing token for ApiKey ${key.id}:`, e);
				await cred.feedback.reportApiKeyStatus(key, false, true, false, false, ctx); // Report temporary failure
				return new Error(`Error refreshing token for ApiKey ${key.id}: ${e.message}`);
			}
		}
		return { keyDataUpdated: keyDataUpdated, accessToken: accessToken, domain: auth.domain, user: account.uid };
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

	async handleOpenAIRequest(ctx: ExecutionContext, request: OpenAIRequest, cred: Credential): Promise<Response | Error> {
		var forceRefresh = false;
		var retries = 0;
		while (true) {
			const key = cred.apiKey;
			const checkResult = await this.checkAndGetAccessToken(ctx, cred, forceRefresh);
			if (checkResult instanceof Error) {
				return checkResult;
			}
			const { keyDataUpdated, accessToken, domain, user } = checkResult;

			let isRateLimited = false;
			let success = false;

			try {
				const response = await this.forwardRequest(accessToken, domain, user, request);

				if (response.status === 429) {
					isRateLimited = true;
					const message = await response.text();
					console.log(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
					return new ThrottledError(`ApiKey ${key.id} was rate-limited. Message: ${message}`);
				} else if (response.status === 401) {
					console.log(`Provider ${key.providerName} returns 401 when using ApiKey ${key.id} (${key.notes}).`);
					forceRefresh = true;
					retries++;
					if (retries < 2) {
						continue;
					} else {
						return response;
					}
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
				await cred.feedback.reportApiKeyStatus(key, success, isRateLimited, keyDataUpdated, false, ctx);
			}
		}
	}

	async handleGeminiRequest(ctx: ExecutionContext, request: GeminiRequest, cred: Credential): Promise<Response | Error> {
		return new Error("Method not implemented. Gemini protocol is not supported.");
	}

	async handleAnthropicRequest(ctx: ExecutionContext, request: AnthropicRequest, cred: Credential): Promise<Response | Error> {
		return new Error("Method not implemented. Anthropic protocol is not supported.");
	}
}

export const codeBuddyHandler = new CodeBuddyHandler();

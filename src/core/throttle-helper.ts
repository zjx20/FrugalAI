import { Prisma, ThrottleMode } from '../generated/prisma';
import { Database } from './db';
import { ApiKeyWithProvider, ExecutionContext } from './types';

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Interface for throttle data stored per model or globally for an API key.
 */
export interface ThrottleData {
	expiration: number; // Timestamp when throttling expires
	currentBackoffDuration: number; // Current exponential backoff duration
	consecutiveFailures: number; // Count of consecutive non-rate-limited failures
}

/**
 * Interface for reporting API key status.
 */
export interface ApiKeyFeedback {
	reportApiKeyStatus(key: ApiKeyWithProvider, success: boolean, isRateLimited?: boolean, isKeyDataUpdated?: boolean, isPermanentlyFailed?: boolean, executionCtx?: ExecutionContext): Promise<void>;
}


/**
 * ApiKeyThrottleHelper class manages API key throttling and status updates.
 * It supports filtering keys, checking expiration, handling throttling (with exponential backoff),
 * and updating key status including persistence of keyData if updated by the caller.
 */
export class ApiKeyThrottleHelper implements ApiKeyFeedback {
	constructor(
		private keys: ApiKeyWithProvider[],
		private db: Database,
		private keyFilter?: (key: ApiKeyWithProvider) => boolean,
		private currentModel: string | null = null // The current model being used for BY_MODEL throttling
	) { }

	/**
	 * Asynchronously yields available API keys.
	 * The iterator filters out permanently failed keys and currently throttled keys.
	 */
	async *getAvailableKeys(): AsyncIterableIterator<ApiKeyWithProvider> {
		const now = Date.now();

		// Filter out candidate keys that are not permanently failed
		const candidateKeys = this.keys.filter(key =>
			(!this.keyFilter || this.keyFilter(key)) && !key.permanentlyFailed
		);

		for (const key of candidateKeys) {
			let currentThrottleData: ThrottleData | null = null;
			let throttleDataMap: Record<string, ThrottleData> | null = null;

			// Safely cast key.throttleData to a Record<string, ThrottleData> if it's a non-array object
			if (typeof key.throttleData === 'object' && key.throttleData !== null && !Array.isArray(key.throttleData)) {
				throttleDataMap = key.throttleData as unknown as Record<string, ThrottleData>;
			}

			// Determine which throttle data to check based on the provider's throttle mode
			if (key.provider.throttleMode === ThrottleMode.BY_KEY) {
				currentThrottleData = throttleDataMap?._global_ || null;
			} else if (key.provider.throttleMode === ThrottleMode.BY_MODEL && this.currentModel) {
				currentThrottleData = throttleDataMap?.[this.currentModel] || null;
			}

			// Check if the key is currently throttled
			if (currentThrottleData && currentThrottleData.expiration > now) {
				console.log(`ApiKey ${key.id} is currently throttled for ${key.provider.throttleMode === ThrottleMode.BY_MODEL ? `model ${this.currentModel}` : 'all models'}. Expires in ${((currentThrottleData.expiration - now) / 1000).toFixed(2)}s.`);
				continue; // Skip currently throttled key
			}

			// If the key is available, yield it
			yield key;
		}
	}

	/**
	 * Reports the status of an API key and updates its throttling and keyData persistence.
	 * @param key The ApiKey object used for the call.
	 * @param success Whether the API call was successful.
	 * @param isRateLimited Whether the API call failed due to rate limiting.
	 * @param isKeyDataUpdated Whether the keyData field of the ApiKey object has been updated by the caller and needs to be persisted.
	 * @param isPermanentlyFailed Whether the API key is considered permanently failed.
	 * @param executionCtx Hono's execution context, used for waitUntil.
	 */
	async reportApiKeyStatus(key: ApiKeyWithProvider, success: boolean, isRateLimited: boolean = false, isKeyDataUpdated: boolean = false, isPermanentlyFailed: boolean = false, executionCtx?: ExecutionContext): Promise<void> {
		let throttleDataMap: Record<string, ThrottleData> = (key.throttleData && typeof key.throttleData === 'object' && !Array.isArray(key.throttleData))
			? key.throttleData as unknown as Record<string, ThrottleData>
			: {};

		// Use provider's min/max throttle durations, fallback to hardcoded defaults if not set
		const minThrottle = key.provider.minThrottleDuration * 1000;
		const maxThrottle = key.provider.maxThrottleDuration * 60 * 1000;

		let targetKey: string = '_global_'; // Default for BY_KEY throttling

		if (key.provider.throttleMode === ThrottleMode.BY_MODEL && this.currentModel) {
			targetKey = this.currentModel;
		}

		const oldThrottleData = throttleDataMap[targetKey] || null;
		let newThrottleData: ThrottleData | null = oldThrottleData;

		const currentBackoffDuration = oldThrottleData?.currentBackoffDuration || minThrottle;
		let consecutiveFailures = oldThrottleData?.consecutiveFailures || 0;

		if (isRateLimited) {
			// If rate-limited, apply exponential backoff and reset consecutive failures.
			const nextBackoff = oldThrottleData ? Math.min(currentBackoffDuration * 2, maxThrottle) : minThrottle;
			const expiration = Date.now() + nextBackoff;
			newThrottleData = {
				expiration,
				currentBackoffDuration: nextBackoff,
				consecutiveFailures: 0 // Reset failures on rate limit
			};
			console.log(`ApiKey ${key.id} was rate-limited for ${targetKey}. Throttling for ${nextBackoff / 1000}s. Resetting failure count.`);
		} else if (success) {
			// If successful, reset throttling and failure status if there was any.
			if (oldThrottleData && (oldThrottleData.expiration > Date.now() || oldThrottleData.consecutiveFailures > 0)) {
				newThrottleData = {
					expiration: 0,
					currentBackoffDuration: minThrottle,
					consecutiveFailures: 0
				};
				console.log(`ApiKey ${key.id} is now healthy for ${targetKey}. Resetting throttle and failure status.`);
			}
		} else { // Failed for a reason other than rate limiting
			consecutiveFailures++;
			console.log(`ApiKey ${key.id} failed for ${targetKey}. Consecutive failures: ${consecutiveFailures}.`);

			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				// Reached max failures, apply exponential backoff and reset counter
				const nextBackoff = oldThrottleData ? Math.min(currentBackoffDuration * 2, maxThrottle) : minThrottle;
				const expiration = Date.now() + nextBackoff;
				newThrottleData = {
					expiration,
					currentBackoffDuration: nextBackoff,
					consecutiveFailures: 0 // Reset after throttling
				};
				console.log(`ApiKey ${key.id} reached max consecutive failures for ${targetKey}. Throttling for ${nextBackoff / 1000}s.`);
			} else {
				// Not at max failures yet, just update the count
				newThrottleData = {
					...(oldThrottleData || { expiration: 0, currentBackoffDuration: minThrottle, consecutiveFailures: 0 }),
					consecutiveFailures: consecutiveFailures
				};
			}
		}

		// Only update the database if throttleData has actually changed, keyData was updated, or key is permanently failed
		const shouldUpdateDbThrottle = JSON.stringify(oldThrottleData) !== JSON.stringify(newThrottleData);

		if (shouldUpdateDbThrottle || isKeyDataUpdated || isPermanentlyFailed) {
			if (newThrottleData && newThrottleData.expiration === 0 && newThrottleData.consecutiveFailures === 0) {
				// If throttling is cleared and there are no failures, remove the entry
				delete throttleDataMap[targetKey];
			} else {
				throttleDataMap[targetKey] = newThrottleData!;
			}

			const updateData: { throttleData?: Prisma.InputJsonValue; keyData?: Prisma.InputJsonValue; permanentlyFailed?: boolean } = {};

			if (shouldUpdateDbThrottle) {
				updateData.throttleData = Object.keys(throttleDataMap).length > 0
					? (throttleDataMap as unknown as Prisma.InputJsonValue)
					: (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
			}

			if (isKeyDataUpdated) {
				updateData.keyData = key.keyData as unknown as Prisma.InputJsonValue;
			}

			if (isPermanentlyFailed) {
				updateData.permanentlyFailed = true;
			}

			const updatePromise = this.db.updateApiKey(key.id, updateData);
			if (executionCtx && executionCtx.waitUntil) {
				executionCtx.waitUntil(updatePromise);
			} else {
				await updatePromise;
			}
		}
	}
}

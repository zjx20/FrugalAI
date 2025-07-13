import { ApiKey, Provider, User, Prisma, ProviderName, ThrottleMode } from './generated/prisma';
import { Database } from './db';

/**
 * Interface for throttle data stored per model or globally for an API key.
 */
export interface ThrottleData {
	expiration: number; // Timestamp when throttling expires
	currentBackoffDuration: number; // Current exponential backoff duration
}

/**
 * ApiKeyThrottleHelper class manages API key throttling and status updates.
 * It supports filtering keys, checking expiration, handling throttling (with exponential backoff),
 * and updating key status including persistence of keyData if updated by the caller.
 */
export class ApiKeyThrottleHelper {
	constructor(
		private user: User & { keys: (ApiKey & { provider: Provider })[] },
		private db: Database,
		private keyFilter: (key: ApiKey & { provider: Provider }) => boolean,
		private currentModel: string | null = null // The current model being used for BY_MODEL throttling
	) { }

	/**
	 * Asynchronously yields available API keys.
	 * The iterator filters out permanently failed keys and currently throttled keys.
	 */
	async *getAvailableKeys(): AsyncIterableIterator<ApiKey & { provider: Provider }> {
		const now = Date.now();

		// Filter out candidate keys that are not permanently failed
		const candidateKeys = this.user.keys.filter(key =>
			this.keyFilter(key) && !key.permanentlyFailed
		);

		for (const key of candidateKeys) {
			let currentThrottleData: ThrottleData | null = null;
			let throttleDataMap: Record<string, ThrottleData> | null = null;

			// Safely cast key.throttleData to a Record<string, ThroottleData> if it's a non-array object
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
	 * @param executionCtx Hono's execution context, used for waitUntil.
	 */
	async reportApiKeyStatus(key: ApiKey & { provider: Provider }, success: boolean, isRateLimited: boolean = false, isKeyDataUpdated: boolean = false, executionCtx?: any): Promise<void> {
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

		let currentThrottleDataForTarget = throttleDataMap[targetKey] || null;
		let currentBackoffDuration = currentThrottleDataForTarget?.currentBackoffDuration || minThrottle;

		let newThrottleData: ThrottleData | null = currentThrottleDataForTarget;

		if (isRateLimited) {
			// If rate-limited, apply exponential backoff
			// If this is the first time being rate-limited, use minThrottle. Otherwise, double the current backoff.
			const nextBackoff = currentThrottleDataForTarget ? Math.min(currentBackoffDuration * 2, maxThrottle) : minThrottle;
			const expiration = Date.now() + nextBackoff;
			newThrottleData = { expiration, currentBackoffDuration: nextBackoff };
			console.log(`ApiKey ${key.id} was rate-limited for ${targetKey}. Throttling for ${nextBackoff / 1000}s. Next backoff: ${nextBackoff / 1000}s.`);
		} else if (success) {
			// If successful, reset throttling status
			if (newThrottleData && newThrottleData.expiration > Date.now()) {
				// If previously throttled, clear the throttling status upon success
				newThrottleData = null;
			}
		} else {
			// If failed but not due to rate limiting, maintain current throttling status (if any)
			// Or consider applying backoff for other types of failures based on specific requirements
		}

		// Only update the database if throttleData has actually changed or keyData was updated
		const oldThrottleData = throttleDataMap[targetKey] || null;
		const shouldUpdateDbThrottle = (oldThrottleData?.expiration !== newThrottleData?.expiration) ||
			(oldThrottleData?.currentBackoffDuration !== newThrottleData?.currentBackoffDuration) ||
			(oldThrottleData === null && newThrottleData !== null) ||
			(oldThrottleData !== null && newThrottleData === null);

		if (shouldUpdateDbThrottle || isKeyDataUpdated) {
			if (newThrottleData === null) {
				delete throttleDataMap[targetKey]; // Remove the entry if throttling is cleared
			} else {
				throttleDataMap[targetKey] = newThrottleData;
			}

			const updateData: { throttleData?: Prisma.InputJsonValue; keyData?: Prisma.InputJsonValue } = {};

			if (shouldUpdateDbThrottle) {
				updateData.throttleData = Object.keys(throttleDataMap).length > 0
					? (throttleDataMap as unknown as Prisma.InputJsonValue)
					: (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
			}

			if (isKeyDataUpdated) {
				updateData.keyData = key.keyData as unknown as Prisma.InputJsonValue;
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

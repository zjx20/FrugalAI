import { Prisma, ThrottleMode } from '../generated/prisma';
import { Database } from './db';
import { ApiKeyWithProvider, ExecutionContext } from './types';

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * ThrottleData captures per-bucket throttling state:
 * - expiration: timestamp when throttling ends (ms since epoch). 0 means not throttled.
 * - currentBackoffDuration: the last applied exponential backoff duration in ms.
 * - consecutiveFailures: non-429 failure count used to trigger throttling when reaching the threshold.
 */
export interface ThrottleData {
	expiration: number;
	currentBackoffDuration: number;
	consecutiveFailures: number;
	lastError?: string;
}

/**
 * ApiKeyFeedback defines the mutation API for reporting call outcomes and batching persistence.
 *
 * Design:
 * - recordKeyDataUpdated: buffer that caller-updated key.keyData should be persisted (no DB write yet).
 * - recordApiKeyPermanentlyFailed: mark the key as permanently failed (sticky flag, no DB write yet).
 * - recordModelStatus: buffer model/global throttle changes in memory using exponential backoff rules.
 * - commitPending: persist all buffered changes with at most one write per key.
 */
export interface ApiKeyFeedback {
	/**
	 * Buffer that caller-updated key.keyData should be persisted (no DB write).
	 */
	recordKeyDataUpdated(key: ApiKeyWithProvider): void;

	/**
	 * Mark the key as permanently failed (sticky flag, no DB write).
	 */
	recordApiKeyPermanentlyFailed(key: ApiKeyWithProvider): void;

	/**
	 * Buffer throttle changes for a specific bucket:
	 * - BY_KEY providers use the global "_global_" bucket (model string is ignored).
	 * - BY_MODEL providers use the provided model string as the bucket key.
	 * Applies exponential backoff on rate limit or max consecutive failures, resets on success.
	 */
	recordModelStatus(
		key: ApiKeyWithProvider,
		model: string,
		success: boolean,
		isRateLimited: boolean,
		lastError?: string,
	): void;

	/**
	 * Persist all buffered updates with at most one write per key.
	 */
	commitPending(executionCtx?: ExecutionContext): Promise<void>;
}

/**
 * Helper: resolve the target throttle bucket key.
 * - BY_MODEL + model provided -> model bucket
 * - otherwise -> "_global_"
 */
function getThrottleTargetKey(providerMode: ThrottleMode, model: string | null): string {
	if (providerMode === ThrottleMode.BY_MODEL && model) {
		return model;
	}
	return '_global_';
}

/**
 * Read the current throttle context for a given bucket:
 * - throttleDataMap: mutable in-memory map for this key (empty object if not set)
 * - oldThrottleData: current bucket's ThrottleData or null
 * - minThrottle/maxThrottle: provider-configured bounds (minutes converted to ms)
 * - consecutiveFailures: current bucket failure count (defaults to 0)
 */
function readThrottleContext(key: ApiKeyWithProvider, targetKey: string) {
	const throttleDataMap =
		typeof key.throttleData === 'object' && key.throttleData !== null && !Array.isArray(key.throttleData)
			? (key.throttleData as unknown as Record<string, ThrottleData>)
			: {};

	const oldThrottleData = throttleDataMap[targetKey] || null;
	const minThrottle = key.provider.minThrottleDuration * 60 * 1000;
	const maxThrottle = key.provider.maxThrottleDuration * 60 * 1000;

	const consecutiveFailures = oldThrottleData?.consecutiveFailures || 0;

	return { throttleDataMap, oldThrottleData, minThrottle, maxThrottle, consecutiveFailures };
}

/**
 * Compute the next ThrottleData for a bucket given the outcome flags:
 * - isRateLimited: apply exponential backoff and reset failures
 * - success: reset to healthy if previously throttled or unhealthy
 * - failure (non-rate-limit): increment failures; when reaching threshold, apply backoff and reset failures
 */
function computeNextThrottleData(
	old: ThrottleData | null,
	success: boolean,
	isRateLimited: boolean,
	consecutiveFailuresBefore: number,
	minMs: number,
	maxMs: number,
	lastError?: string,
): { newThrottleData: ThrottleData | null } {
	const now = Date.now();
	const currentBackoff = old?.currentBackoffDuration ?? minMs;
	const consecutiveFailures = consecutiveFailuresBefore;

	if (isRateLimited) {
		const nextBackoff = old ? Math.min(currentBackoff * 2, maxMs) : minMs;
		return {
			newThrottleData: { expiration: now + nextBackoff, currentBackoffDuration: nextBackoff, consecutiveFailures: 0, lastError: lastError },
		};
	}

	if (success) {
		if (old && (old.expiration > now || old.consecutiveFailures > 0 || old.currentBackoffDuration > minMs)) {
			return {
				newThrottleData: { expiration: 0, currentBackoffDuration: minMs, consecutiveFailures: 0 },
			};
		}
		return { newThrottleData: old };
	}

	const newFailures = consecutiveFailures + 1;
	if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
		const nextBackoff = old ? Math.min(currentBackoff * 2, maxMs) : minMs;
		return {
			newThrottleData: { expiration: now + nextBackoff, currentBackoffDuration: nextBackoff, consecutiveFailures: 0, lastError: lastError },
		};
	} else {
		return {
			newThrottleData: {
				...(old || { expiration: 0, currentBackoffDuration: minMs, consecutiveFailures: 0 }),
				consecutiveFailures: newFailures,
				lastError: lastError,
			},
		};
	}
}

/**
 * Apply new throttle data into the map:
 * - Healthy state (expiration 0, failures 0, backoff == minMs) removes the bucket entry to keep the map compact
 * - Otherwise, set/overwrite the bucket entry
 */
function applyNewThrottleData(
	throttleDataMap: Record<string, ThrottleData>,
	targetKey: string,
	newThrottleData: ThrottleData | null,
	minMs: number
) {
	if (
		newThrottleData &&
		newThrottleData.expiration === 0 &&
		newThrottleData.consecutiveFailures === 0 &&
		newThrottleData.currentBackoffDuration === minMs
	) {
		delete throttleDataMap[targetKey];
	} else if (newThrottleData) {
		throttleDataMap[targetKey] = newThrottleData;
	}
}

/**
 * Detect whether throttle data changed at a field level.
 */
function throttleChanged(a: ThrottleData | null, b: ThrottleData | null): boolean {
	if (!a && !b) return false;
	if (!a || !b) return true;
	return (
		a.expiration !== b.expiration ||
		a.currentBackoffDuration !== b.currentBackoffDuration ||
		a.consecutiveFailures !== b.consecutiveFailures
	);
}

/**
 * ApiKeyThrottleHelper:
 * - Filters out throttled/permanently failed keys per model on read-side
 * - Buffers key-level and bucket-level mutations in-memory
 * - Persists all buffered changes in a single commit per key
 */
export class ApiKeyThrottleHelper implements ApiKeyFeedback {
	constructor(
		private keys: ApiKeyWithProvider[],
		private db: Database,
		private keyFilter?: (key: ApiKeyWithProvider) => boolean,
	) { }

	private pendingUpdates = new Map<
		number,
		{ throttleData?: Prisma.InputJsonValue; keyData?: Prisma.InputJsonValue; permanentlyFailed?: boolean }
	>();

	/**
	 * Query-only helper to check throttling for the given key and model.
	 * - BY_KEY: checks "_global_" bucket
	 * - BY_MODEL: checks the provided model bucket
	 */
	isModelThrottled(
		key: ApiKeyWithProvider,
		model: string,
		now: number = Date.now()
	): { throttled: boolean; remainingMs: number; throttleData: ThrottleData | null } {
		const throttleDataMap =
			typeof key.throttleData === 'object' && key.throttleData !== null && !Array.isArray(key.throttleData)
				? (key.throttleData as unknown as Record<string, ThrottleData>)
				: {};

		let data: ThrottleData | null = null;
		if (key.provider.throttleMode === ThrottleMode.BY_KEY) {
			data = throttleDataMap['_global_'] || null;
		} else if (key.provider.throttleMode === ThrottleMode.BY_MODEL) {
			data = throttleDataMap[model] || null;
		}

		if (data && data.expiration > now) {
			return { throttled: true, remainingMs: Math.max(0, data.expiration - now), throttleData: data };
		}
		return { throttled: false, remainingMs: 0, throttleData: data };
	}

	/**
	 * Yield available keys for a specific model:
	 * - Excludes permanently failed keys
	 * - Excludes currently throttled keys for that model (or globally for BY_KEY)
	 * - Sorts by consecutive failure count ascending to prefer healthier keys
	 */
	async *getAvailableKeys(model: string): AsyncIterableIterator<ApiKeyWithProvider> {
		const now = Date.now();
		const filteredKeys = this.keys.filter((key) => (!this.keyFilter || this.keyFilter(key)) && !key.permanentlyFailed);

		const candidateKeys: { key: ApiKeyWithProvider; throttleData: ThrottleData | null }[] = [];

		for (const key of filteredKeys) {
			const { throttled, remainingMs, throttleData } = this.isModelThrottled(key, model, now);
			if (throttled) {
				console.log(
					`ApiKey ${key.id} is currently throttled for ${key.provider.throttleMode === ThrottleMode.BY_MODEL ? `model "${model}"` : 'all models'
					}. Expires in ${(remainingMs / 1000).toFixed(2)}s.`
				);
				continue;
			}

			candidateKeys.push({ key, throttleData: throttleData });
		}

		candidateKeys.sort((a, b) => {
			const aFailures = a.throttleData?.consecutiveFailures || 0;
			const bFailures = b.throttleData?.consecutiveFailures || 0;
			return aFailures - bFailures;
		});

		for (const cand of candidateKeys) {
			yield cand.key;
		}
	}

	/**
	 * Buffer that caller-updated keyData should be persisted.
	 */
	recordKeyDataUpdated(key: ApiKeyWithProvider): void {
		const update = this.pendingUpdates.get(key.id) || {};
		update.keyData = key.keyData as unknown as Prisma.InputJsonValue;
		this.pendingUpdates.set(key.id, update);
	}

	/**
	 * Mark the key as permanently failed.
	 */
	recordApiKeyPermanentlyFailed(key: ApiKeyWithProvider): void {
		const update = this.pendingUpdates.get(key.id) || {};
		update.permanentlyFailed = true;
		key.permanentlyFailed = true;
		this.pendingUpdates.set(key.id, update);
	}

	/**
	 * Buffer throttle changes for the target bucket (global or per model).
	 * - Applies exponential backoff on rate limit or excessive consecutive failures
	 * - Resets to healthy on success
	 */
	recordModelStatus(
		key: ApiKeyWithProvider,
		model: string,
		success: boolean,
		isRateLimited: boolean,
		lastError?: string,
	): void {
		const targetKey = getThrottleTargetKey(key.provider.throttleMode, model);

		const { throttleDataMap, oldThrottleData, minThrottle, maxThrottle, consecutiveFailures } = readThrottleContext(
			key,
			targetKey
		);

		const { newThrottleData } = computeNextThrottleData(
			oldThrottleData,
			success,
			isRateLimited,
			consecutiveFailures,
			minThrottle,
			maxThrottle,
			lastError
		);

		const changed = throttleChanged(oldThrottleData, newThrottleData);

		if (changed) {
			applyNewThrottleData(throttleDataMap, targetKey, newThrottleData, minThrottle);
			// reflect in-memory for subsequent reads
			key.throttleData = throttleDataMap as unknown as Prisma.JsonValue;
		}

		if (changed) {
			const update = this.pendingUpdates.get(key.id) || {};
			update.throttleData =
				Object.keys(throttleDataMap).length > 0
					? (throttleDataMap as unknown as Prisma.InputJsonValue)
					: (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
			this.pendingUpdates.set(key.id, update);
		}
	}

	/**
	 * Persist all buffered updates in a single batch:
	 * - One DB write per key
	 * - Clears the buffer after scheduling/awaiting writes
	 */
	async commitPending(executionCtx?: ExecutionContext): Promise<void> {
		if (this.pendingUpdates.size === 0) return;

		const tasks: Promise<any>[] = [];
		for (const [keyId, update] of this.pendingUpdates.entries()) {
			tasks.push(this.db.updateApiKey(keyId, update));
		}

		this.pendingUpdates.clear();

		if (executionCtx && executionCtx.waitUntil) {
			executionCtx.waitUntil(Promise.all(tasks));
		} else {
			await Promise.all(tasks);
		}
	}
}

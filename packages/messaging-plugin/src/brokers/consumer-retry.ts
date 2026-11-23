/** Portable consumer retry validation with transport-specific bounds. @module */
import type { ConsumerRetryOptions } from '../interfaces/index.ts';

/** Validated retry configuration, owned by one broker. @since 0.14.0 */
export type ResolvedConsumerRetry = {
  /** Whether handler failures use the configured retry policy. @since 0.14.0 */
  readonly retry: boolean;
  /** Maximum delivery attempts. @since 0.14.0 */
  readonly maxAttempts: number;
  /** Delay sequence, repeated at the last element. @since 0.14.0 */
  readonly delaysMs: readonly number[];
  /** Optional application classifier. @since 0.14.0 */
  readonly isRetryable: ((error: unknown) => boolean) | undefined;
};

/**
 * Resolves a consumer policy before any transport I/O.
 * @param value - Caller policy, false to disable, or undefined for defaults
 * @param broker - Broker name used in value-free refusals
 * @param bounds - Defaults and transport limits
 * @returns A snapshot of the validated retry policy
 * @throws {RangeError} When a budget, delay sequence or classifier is invalid
 * @since 0.14.0
 */
export function resolveConsumerRetry(
  value: false | ConsumerRetryOptions | undefined,
  broker: string,
  bounds: {
    readonly defaults: readonly number[];
    readonly minDelay?: number;
    readonly maxDelay?: number;
    readonly minAttempts?: number;
    readonly maxAttempts?: number;
    readonly maxDelays?: number;
  },
): ResolvedConsumerRetry {
  if (value !== undefined && value !== false && (value === null || typeof value !== 'object')) {
    throw new RangeError(`${broker} consumerRetry must be false or an options object`);
  }
  const configured = value === false ? undefined : value;
  const maxAttempts = configured?.maxAttempts ?? 5;
  const minAttempts = bounds.minAttempts ?? 1;
  const max = bounds.maxAttempts ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < minAttempts || maxAttempts > max) {
    throw new RangeError(
      `${broker} consumerRetry.maxAttempts must be a positive integer within its bound`,
    );
  }
  const delaysMs = [...(configured?.delaysMs ?? bounds.defaults)];
  if (delaysMs.length === 0)
    throw new RangeError(`${broker} consumerRetry.delaysMs must be nonempty`);
  if (bounds.maxDelays !== undefined && delaysMs.length > bounds.maxDelays) {
    throw new RangeError(
      `${broker} consumerRetry.delaysMs accepts one or two entries: Pub/Sub uses minimum and maximum backoff, not a retry sequence`,
    );
  }
  for (const [index, delay] of delaysMs.entries()) {
    if (
      !Number.isSafeInteger(delay) ||
      delay < (bounds.minDelay ?? 1) ||
      delay > (bounds.maxDelay ?? 2147483647)
    ) {
      throw new RangeError(
        `${broker} consumerRetry.delaysMs must be a positive integer within its bound`,
      );
    }
    if (index > 0 && delay < delaysMs[index - 1]!)
      throw new RangeError(`${broker} consumerRetry.delaysMs must be nondecreasing`);
  }
  if (configured?.isRetryable !== undefined && typeof configured.isRetryable !== 'function') {
    throw new RangeError(`${broker} consumerRetry.isRetryable must be a function`);
  }
  return { retry: value !== false, maxAttempts, delaysMs, isRetryable: configured?.isRetryable };
}

/**
 * Resolves Pub/Sub policy bounds at both the plugin and direct broker entry points.
 * @param options - Retry policy and optional dead-letter topic
 * @returns The validated policy snapshot
 * @throws {RangeError} For invalid platform bounds or a classifier without a target
 * @since 0.14.0
 */
export function resolvePubSubRetry(options?: {
  consumerRetry?: false | ConsumerRetryOptions;
  deadLetterTopic?: string;
}): ResolvedConsumerRetry {
  const retry = resolveConsumerRetry(options?.consumerRetry, 'GcpPubSubBroker', {
    defaults: [10000, 600000],
    minDelay: 0,
    maxDelay: 600000,
    minAttempts: options?.deadLetterTopic === undefined ? 1 : 5,
    maxAttempts: options?.deadLetterTopic === undefined ? Number.MAX_SAFE_INTEGER : 100,
    maxDelays: 2,
  });
  if (retry.isRetryable !== undefined && options?.deadLetterTopic === undefined)
    throw new RangeError('GcpPubSubBroker consumerRetry.isRetryable requires deadLetterTopic');
  return retry;
}

/**
 * Resolves Service Bus policy bounds at both construction entry points.
 * @param value - Consumer retry policy
 * @returns The validated held-retry policy
 * @throws {RangeError} For an invalid budget, classifier or unsafe hold
 * @since 0.14.0
 */
export function resolveServiceBusRetry(
  value?: false | ConsumerRetryOptions,
): ResolvedConsumerRetry {
  return resolveConsumerRetry(value, 'ServiceBusBroker', {
    defaults: [1000, 5000, 30000, 120000],
    minDelay: 1,
    maxDelay: 239999,
  });
}

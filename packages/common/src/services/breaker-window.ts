/**
 * The circuit-breaker trip rule, written once.
 *
 * @module
 *
 * {@linkcode createBreakerWindow} holds the failure window a circuit breaker
 * consults while it is closed, for both arms of
 * {@linkcode CircuitBreakerPolicy}: the count arm (`threshold` failures within
 * `timeout`, timestamped exactly) and the rate arm (`failureRateThreshold`
 * percent of at least `minimumCalls` calls within `timeout`, kept in ten
 * buckets). It decides only whether a failure trips the policy. The half-open
 * state machine, cancellation, error classes and when to call
 * {@linkcode IBreakerWindow.reset} stay with each breaker.
 *
 * A success never clears recorded failures. The module is pure: the clock is
 * a function the caller passes (a monotonic millisecond reading such as
 * `runtime.hrtime`), and it imports nothing at run time, so it is also served
 * on its own as `@setu-ts/common/breaker-window` for clients that load no
 * other `common` code.
 *
 * @since 0.14.0
 */
import type {
  CircuitBreakerCountPolicy,
  CircuitBreakerPolicy,
  CircuitBreakerRatePolicy,
} from './resilience.ts';

/**
 * The largest duration a policy may name: the runtime timer range. Kept local
 * so this module stays free of runtime imports.
 */
const MAX_DURATION_MS = 2_147_483_647;

/** Number of buckets the rate arm divides its window into. */
const BUCKETS = 10;

/**
 * The failure window of one circuit breaker.
 *
 * @since 0.14.0
 */
export interface IBreakerWindow {
  /**
   * Records a call that succeeded. It never clears recorded failures. On the
   * count arm it does nothing; on the rate arm it adds a call to the window.
   * It never reports a trip: a success that brings the window up to
   * `minimumCalls` while the rate is already over the threshold leaves the
   * decision to the next failure.
   */
  recordSuccess(): void;
  /**
   * Records a call that failed.
   *
   * @returns `true` when this failure trips the policy: on the count arm, the
   * window holds at least `threshold` failures; on the rate arm, it holds at
   * least `minimumCalls` calls and at least `failureRateThreshold` percent of
   * them are failures
   */
  recordFailure(): boolean;
  /** Empties the window. */
  reset(): void;
  /**
   * Failures currently in the window, read against the clock now. On the
   * count arm it never exceeds `threshold`: older failures cannot change a
   * trip decision and are not kept.
   */
  readonly failures: number;
}

/** Formats a refused value for a message without ever throwing. */
function received(value: unknown): string {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    return 'an unprintable value';
  }
}

/** A refusal naming the field, its rule and the received value. */
function refusal(field: string, rule: string, value: unknown): RangeError {
  return new RangeError(`circuitBreaker.${field} must be ${rule}; received ${received(value)}`);
}

/** True for a finite number within `[min, max]`. */
function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** True for a safe integer of at least 1. */
function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Checks a circuit-breaker policy, returning the refusal or `null` when it is
 * valid. It is the one check for a {@linkcode CircuitBreakerPolicy}:
 * {@linkcode createBreakerWindow} throws it, and the SDK client runs it when it
 * is built.
 *
 * The arm is decided by presence (a field is present when it is not
 * `undefined`): `threshold` together with `failureRateThreshold` or
 * `minimumCalls` is refused as both arms; no `threshold` and no
 * `failureRateThreshold` is refused as neither. Then:
 *
 * - `threshold`, `minimumCalls`: a positive safe integer
 * - `failureRateThreshold`: a finite number from 1 to 100
 * - `timeout`: a finite number greater than 0 (count arm) or from 10 (rate
 *   arm, so each of its ten buckets is at least 1 ms), at most 2147483647
 * - `resetTimeout`: a finite number from 0 to 2147483647
 *
 * @example
 * ```typescript
 * breakerPolicyRangeError({ threshold: 0, timeout: 1000, resetTimeout: 500 })?.message;
 * // 'circuitBreaker.threshold must be a positive safe integer; received 0'
 * ```
 * @param policy - The policy to check (read as untrusted: it may come from
 * JavaScript or configuration)
 * @returns The `RangeError` to throw, or `null` when the policy is valid
 * @since 0.14.0
 */
export function breakerPolicyRangeError(policy: CircuitBreakerPolicy): RangeError | null {
  const fields = policy as {
    readonly threshold?: unknown;
    readonly failureRateThreshold?: unknown;
    readonly minimumCalls?: unknown;
    readonly timeout?: unknown;
    readonly resetTimeout?: unknown;
  };
  const hasCount = fields.threshold !== undefined;
  const hasRate = fields.failureRateThreshold !== undefined || fields.minimumCalls !== undefined;
  if (hasCount && hasRate) {
    return new RangeError(
      'circuitBreaker must set either threshold or failureRateThreshold, not both',
    );
  }
  if (!hasCount && fields.failureRateThreshold === undefined) {
    return new RangeError(
      'circuitBreaker must set either threshold or failureRateThreshold, received neither',
    );
  }
  if (hasCount) {
    if (!isPositiveInteger(fields.threshold)) {
      return refusal('threshold', 'a positive safe integer', fields.threshold);
    }
    const timeoutValid =
      inRange(fields.timeout, 0, MAX_DURATION_MS) && (fields.timeout as number) > 0;
    if (!timeoutValid) {
      return refusal(
        'timeout',
        `a finite number greater than 0 and at most ${MAX_DURATION_MS}`,
        fields.timeout,
      );
    }
  } else {
    if (!inRange(fields.failureRateThreshold, 1, 100)) {
      return refusal(
        'failureRateThreshold',
        'a finite number from 1 to 100',
        fields.failureRateThreshold,
      );
    }
    if (!isPositiveInteger(fields.minimumCalls)) {
      return refusal('minimumCalls', 'a positive safe integer', fields.minimumCalls);
    }
    if (!inRange(fields.timeout, BUCKETS, MAX_DURATION_MS)) {
      return refusal(
        'timeout',
        `a finite number from ${BUCKETS} to ${MAX_DURATION_MS}`,
        fields.timeout,
      );
    }
  }
  if (!inRange(fields.resetTimeout, 0, MAX_DURATION_MS)) {
    return refusal(
      'resetTimeout',
      `a finite number from 0 to ${MAX_DURATION_MS}`,
      fields.resetTimeout,
    );
  }
  return null;
}

/** The count arm: exact failure timestamps, at most `threshold` of them. */
function countWindow(policy: CircuitBreakerCountPolicy, now: () => number): IBreakerWindow {
  const { threshold, timeout } = policy;
  let stamps: number[] = [];
  return {
    recordSuccess(): void {},
    recordFailure(): boolean {
      const at = now();
      stamps.push(at);
      stamps = stamps.filter((stamp) => at - stamp < timeout);
      if (stamps.length > threshold) {
        stamps = stamps.slice(stamps.length - threshold);
      }
      return stamps.length >= threshold;
    },
    reset(): void {
      stamps = [];
    },
    get failures(): number {
      const at = now();
      return stamps.filter((stamp) => at - stamp < timeout).length;
    },
  };
}

/** The rate arm: ten aligned buckets of calls and failures over `timeout`. */
function rateWindow(policy: CircuitBreakerRatePolicy, now: () => number): IBreakerWindow {
  const { failureRateThreshold, minimumCalls, timeout } = policy;
  const width = timeout / BUCKETS;
  const keys: number[] = new Array<number>(BUCKETS).fill(-Infinity);
  const calls: number[] = new Array<number>(BUCKETS).fill(0);
  const failed: number[] = new Array<number>(BUCKETS).fill(0);

  const currentKey = (): number => Math.floor(now() / width);
  /** The slot for `key`, zeroed first when it last held another bucket. */
  const slot = (key: number): number => {
    const index = ((key % BUCKETS) + BUCKETS) % BUCKETS;
    if (keys[index] !== key) {
      keys[index] = key;
      calls[index] = 0;
      failed[index] = 0;
    }
    return index;
  };
  /** Calls and failures in the buckets still inside the window at `key`. */
  const totals = (key: number): { calls: number; failures: number } => {
    let windowCalls = 0;
    let windowFailures = 0;
    for (let index = 0; index < BUCKETS; index++) {
      if (key - keys[index]! < BUCKETS) {
        windowCalls += calls[index]!;
        windowFailures += failed[index]!;
      }
    }
    return { calls: windowCalls, failures: windowFailures };
  };

  return {
    recordSuccess(): void {
      calls[slot(currentKey())]! += 1;
    },
    recordFailure(): boolean {
      const key = currentKey();
      const index = slot(key);
      calls[index]! += 1;
      failed[index]! += 1;
      const window = totals(key);
      // The documented form, divided rather than cross-multiplied: with a
      // fractional threshold (100 / 11) the two round differently.
      return (
        window.calls >= minimumCalls &&
        (window.failures * 100) / window.calls >= failureRateThreshold
      );
    },
    reset(): void {
      keys.fill(-Infinity);
      calls.fill(0);
      failed.fill(0);
    },
    get failures(): number {
      return totals(currentKey()).failures;
    },
  };
}

/**
 * Creates the failure window for one circuit breaker.
 *
 * Each policy field is read once into a copy, which is checked with
 * {@linkcode breakerPolicyRangeError} and then used, so changing the caller's
 * object afterwards changes nothing.
 *
 * - **Count arm:** each failure is timestamped exactly; it trips when at least
 *   `threshold` failures are less than `timeout` old.
 * - **Rate arm:** calls and failures go into ten buckets of `timeout / 10` ms
 *   aligned on the clock; a bucket leaves the window ten widths after it
 *   began, so a call counts for between `0.9 · timeout` and `timeout`. It trips
 *   when the window holds at least `minimumCalls` calls and
 *   `failures * 100 / calls >= failureRateThreshold`.
 *
 * @example
 * ```typescript
 * const window = createBreakerWindow(
 *   { failureRateThreshold: 50, minimumCalls: 20, timeout: 10_000, resetTimeout: 5_000 },
 *   () => performance.now(),
 * );
 * window.recordSuccess();
 * const tripped = window.recordFailure();
 * ```
 * @param policy - The breaker policy
 * @param now - A monotonic clock in milliseconds
 * @returns The window
 * @throws {RangeError} When the policy is invalid
 * @since 0.14.0
 */
export function createBreakerWindow(
  policy: CircuitBreakerPolicy,
  now: () => number,
): IBreakerWindow {
  // Each field is read exactly once, into a plain object that is both checked
  // and used: a getter cannot pass the check and then return something else.
  const snapshot = {
    threshold: policy.threshold,
    failureRateThreshold: policy.failureRateThreshold,
    minimumCalls: policy.minimumCalls,
    timeout: policy.timeout,
    resetTimeout: policy.resetTimeout,
  };
  const error = breakerPolicyRangeError(snapshot as CircuitBreakerPolicy);
  if (error !== null) {
    throw error;
  }
  if (snapshot.threshold !== undefined) {
    return countWindow(
      {
        threshold: snapshot.threshold,
        timeout: snapshot.timeout,
        resetTimeout: snapshot.resetTimeout,
      },
      now,
    );
  }
  return rateWindow(
    {
      failureRateThreshold: snapshot.failureRateThreshold as number,
      minimumCalls: snapshot.minimumCalls as number,
      timeout: snapshot.timeout,
      resetTimeout: snapshot.resetTimeout,
    },
    now,
  );
}

/** Cancelling driver deadlines shared by the three NoSQL adapter facades. @module */
import { deadlineRangeError } from '@setu-ts/common';
import { DatabaseTimeoutError } from '../errors.ts';

/** Validates the common option once, at adapter construction. @internal */
export function requestTimeout(value: number | undefined): number {
  const timeout = value ?? 15_000;
  const error = deadlineRangeError('requestTimeoutMs', timeout);
  if (error) throw error;
  return timeout;
}

/**
 * Bounds one driver call: passes cancellation to the driver AND rejects at the
 * deadline itself. The timeout's `cause` is the driver's error when the driver
 * answers the abort, else the signal's `TimeoutError`.
 *
 * The signal alone is not a bound: a driver may wait without observing it
 * (`@azure/cosmos` 4.10.2 sleeps through a throttle retry-after with a bare
 * timer), so the call settles only when that wait ends. Rejecting at the
 * deadline ends the call at `requestTimeoutMs` whatever the driver does; any
 * request the driver still sends afterwards carries the aborted signal.
 * `0` disables both. @internal
 */
export async function requestBound<T>(
  timeout: number,
  run: (options: { abortSignal?: AbortSignal }) => Promise<T>,
  grpc = false,
): Promise<T> {
  // AbortSignal.timeout requires an integer even though the public range accepts fractions.
  const signal = timeout === 0 ? undefined : AbortSignal.timeout(Math.ceil(timeout));
  let onAbort: (() => void) | undefined;
  try {
    if (signal === undefined) return await run({});
    const call = run({ abortSignal: signal });
    // Registered after `run`, and settling one macrotask later, so a driver
    // that answers the abort rejects first and its error becomes the cause.
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => setTimeout(() => reject(signal.reason), 0);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // The call may settle after the deadline won; its outcome is then unread.
    call.catch(() => {});
    return await Promise.race([call, deadline]);
  } catch (cause) {
    if (
      signal?.aborted ||
      (timeout > 0 &&
        grpc &&
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { code?: unknown }).code === 4)
    ) {
      throw new DatabaseTimeoutError(
        'The database call exceeded requestTimeoutMs; its outcome is unknown.',
        { cause },
      );
    }
    throw cause;
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/** `instanceof` that cannot throw on a hostile rejection value (a revoked Proxy). @internal */
export function isDatabaseTimeout(error: unknown): boolean {
  try {
    return error instanceof DatabaseTimeoutError;
  } catch {
    return false;
  }
}

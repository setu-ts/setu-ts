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

/** Passes cancellation to the driver and preserves its error as the timeout cause. @internal */
export async function requestBound<T>(
  timeout: number,
  run: (options: { abortSignal?: AbortSignal }) => Promise<T>,
  grpc = false,
): Promise<T> {
  // AbortSignal.timeout requires an integer even though the public range accepts fractions.
  const signal = timeout === 0 ? undefined : AbortSignal.timeout(Math.ceil(timeout));
  try {
    return await run(signal === undefined ? {} : { abortSignal: signal });
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

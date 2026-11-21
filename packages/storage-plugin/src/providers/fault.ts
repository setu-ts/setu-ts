/**
 * The one place storage faults are bounded and classified.
 *
 * Every cloud provider (S3/B2, GCS, Azure) runs each backend call through
 * {@linkcode runBounded} and turns every rejection it does not itself read as
 * "not found" into {@linkcode toStorageError}. A backend that does not answer
 * therefore ends within `requestTimeoutMs`, and an outage reaches the caller as
 * a `503` or `504` that names the provider instead of a masked `500`.
 *
 * Internal: nothing here is exported from the package barrel.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  deadlineRangeError,
  toBackendFault,
  withDeadline,
} from '@setu-ts/common';

/** The provider calls a storage fault is classified for. */
export type StorageOperation =
  'put' | 'get' | 'delete' | 'exists' | 'getSignedUrl' | 'getStream' | 'probe';

/**
 * The bound one provider applies to each backend call.
 *
 * `timeoutMs` `0` disables the bound; `timing` is the runtime's timer surface
 * (ambient timers when absent).
 */
export interface StorageDeadline {
  readonly timeoutMs: number;
  readonly timing?: DeadlineOptions['timing'];
}

/** Default `requestTimeoutMs` of every cloud storage provider. */
export const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 30_000;

/** Calls that change the store: a fault after sending may have been applied. */
const WRITES: ReadonlySet<StorageOperation> = new Set(['put', 'delete']);

/** The longest cause message copied into a provider-named error. */
const MAX_CAUSE_MESSAGE = 300;

/** The error a call rejects with when its bound expires. */
export class StorageDeadlineError extends Error {
  override readonly name = 'StorageDeadlineError';
}

/**
 * Resolves and checks a provider's `requestTimeoutMs`.
 *
 * @param value - The configured value, or `undefined` for the default
 * @returns The bound in milliseconds
 * @throws {RangeError} When the value is not a finite number in the timer range
 */
export function resolveRequestTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_STORAGE_REQUEST_TIMEOUT_MS;
  const refusal = deadlineRangeError('requestTimeoutMs', timeoutMs);
  if (refusal !== null) throw refusal;
  return timeoutMs;
}

/**
 * Runs one backend call under the provider's bound.
 *
 * The call receives the deadline's signal, to hand to an SDK that accepts one;
 * an SDK that does not is still bounded, because the deadline races the call.
 *
 * @param deadline - The provider's bound
 * @param provider - The provider name, for the expiry message
 * @param operation - The call, for the expiry message
 * @param run - The backend call
 * @returns The call's value, or a rejection with its error or the deadline's
 */
export function runBounded<T>(
  deadline: StorageDeadline,
  provider: string,
  operation: StorageOperation,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withDeadline(run, {
    timeoutMs: deadline.timeoutMs,
    onTimeout: () =>
      new StorageDeadlineError(
        `storage-plugin (${provider}): ${operation} did not answer within ${deadline.timeoutMs} ms`,
      ),
    ...(deadline.timing !== undefined && { timing: deadline.timing }),
  });
}

/**
 * Reads the HTTP status a backend answered, from the shapes the three SDKs
 * use: AWS `$metadata.httpStatusCode`, Azure `statusCode`, GCS numeric `code`.
 *
 * @param error - The thrown value
 * @returns The status, or `undefined` when none was answered
 */
export function answeredStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as {
    $metadata?: { httpStatusCode?: unknown };
    statusCode?: unknown;
    code?: unknown;
  };
  for (const candidate of [record.$metadata?.httpStatusCode, record.statusCode, record.code]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}

/**
 * Classifies a provider call's rejection.
 *
 * - The bound expired, or the connection failed in a recognised way
 *   (`toBackendFault`'s table), or the backend answered `500`, `502`, `503` or
 *   `504`: a read becomes `BackendUnavailableError` (`503`); a write becomes
 *   `BackendUnavailableError` when the request was refused before it was sent
 *   or answered `502`/`503`, and `BackendOutcomeUnknownError` (`504`) when it
 *   may have been applied (an expired bound, a lost connection, `500`, `504`).
 * - Anything else (a refused credential, a missing bucket) becomes a plain
 *   `Error` whose message names the plugin, the provider and the call, with the
 *   original as `cause`: the response stays a masked `500`, and the log says
 *   which backend failed.
 *
 * @param error - The rejection
 * @param provider - The provider name (`s3`, `b2`, `gcs`, `azure`)
 * @param operation - The call that failed
 * @returns The error to throw
 */
export function toStorageError(
  error: unknown,
  provider: string,
  operation: StorageOperation,
): Error {
  if (error instanceof BackendUnavailableError || error instanceof BackendOutcomeUnknownError) {
    return error;
  }
  const label = `storage-plugin (${provider}): ${operation}`;
  const write = WRITES.has(operation);
  let fault: 'unavailable' | 'outcome-unknown' | undefined;
  if (error instanceof StorageDeadlineError) {
    fault = 'outcome-unknown';
  } else {
    const classified = toBackendFault(error, label);
    if (classified instanceof BackendUnavailableError) fault = 'unavailable';
    else if (classified instanceof BackendOutcomeUnknownError) fault = 'outcome-unknown';
    else {
      const status = answeredStatus(error);
      if (status === 502 || status === 503) fault = 'unavailable';
      else if (status === 500 || status === 504) fault = 'outcome-unknown';
    }
  }
  if (fault === 'unavailable' || (fault === 'outcome-unknown' && !write)) {
    return new BackendUnavailableError(label, { cause: error });
  }
  if (fault === 'outcome-unknown') {
    return new BackendOutcomeUnknownError(label, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${label} failed: ${message.slice(0, MAX_CAUSE_MESSAGE)}`, { cause: error });
}

/**
 * Reports whether a backend's rejection still proves it answered: an HTTP
 * status below `500`. The readiness rule of the GCS and Azure probes — a
 * refused credential or a missing bucket is an answer, not an outage.
 *
 * @param error - The probe's rejection
 * @returns `true` when the backend answered
 */
export function answeredBelow500(error: unknown): boolean {
  const status = answeredStatus(error);
  return status !== undefined && status < 500;
}

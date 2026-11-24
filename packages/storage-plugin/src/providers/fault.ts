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
 *   or answered `503`, on the SDK's only attempt, and `BackendOutcomeUnknownError`
 *   (`504`) when it may have been applied (an expired bound, a lost connection,
 *   `500`, `502`, `504`, or any refusal after the SDK retried).
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
      if (status === 503) fault = 'unavailable';
      else if (status === 500 || status === 502 || status === 504) fault = 'outcome-unknown';
    }
  }
  // An SDK that retried (the AWS SDK records `$metadata.attempts`) may have
  // applied an earlier attempt whose answer was lost: only a single refusal
  // proves a write did not land.
  if (fault === 'unavailable' && write && attemptsOf(error) > 1) fault = 'outcome-unknown';
  if (fault === 'unavailable' || (fault === 'outcome-unknown' && !write)) {
    return new BackendUnavailableError(label, { cause: error });
  }
  if (fault === 'outcome-unknown') {
    return new BackendOutcomeUnknownError(label, { cause: error });
  }
  const message = error instanceof Error ? error.message : describeValue(error);
  // Control characters (CR/LF, C1 and the Unicode line separators included) are
  // replaced, so a backend's text
  // cannot forge a log line.
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const printable = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return new Error(`${label} failed: ${printable.slice(0, MAX_CAUSE_MESSAGE)}`, { cause: error });
}

/**
 * The attempts an SDK made before it rejected (`$metadata.attempts`), `1` when
 * it records none.
 *
 * @param error - The rejection
 * @returns The attempt count
 */
function attemptsOf(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 1;
  const attempts = (error as { $metadata?: { attempts?: unknown } }).$metadata?.attempts;
  return typeof attempts === 'number' && attempts > 1 ? attempts : 1;
}

/**
 * Text for a rejection that is not an `Error`; a value that cannot be turned
 * into text (an object with no prototype) gets a fixed description, so the
 * original stays the `cause` instead of a `TypeError` replacing it.
 *
 * @param value - The rejection
 * @returns Its text
 */
function describeValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'a value with no text form';
  }
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

/**
 * Destroys a node body stream when the signal aborts, so a read the bound cut
 * short releases its connection. A body without `destroy` is left alone.
 *
 * @param body - The SDK response body
 * @param signal - The bound's signal
 */
export function destroyOnAbort(body: unknown, signal: AbortSignal): void {
  const destroy = (body as { destroy?: unknown } | null | undefined)?.destroy;
  if (typeof destroy !== 'function') return;
  const release = (): void => {
    (destroy as () => void).call(body);
  };
  if (signal.aborted) release();
  else signal.addEventListener('abort', release, { once: true });
}

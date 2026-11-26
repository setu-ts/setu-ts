/**
 * The one place the cloud secrets providers (AWS Secrets Manager, GCP Secret
 * Manager, Azure Key Vault) bound a backend call and classify its failure.
 *
 * An outage — a refused or lost connection, an expired `requestTimeoutMs`, a
 * `5xx` answer, a gRPC `UNAVAILABLE` or `DEADLINE_EXCEEDED` — becomes
 * {@linkcode SecretProviderUnavailableError} (`503`), as the Vault provider has
 * answered since 0.9.0. Any other failure (a refused credential, a malformed
 * name) becomes a plain `Error` naming the provider and the call, so the masked
 * `500` says which backend failed.
 *
 * Internal: nothing here is exported from the package barrel.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import { deadlineRangeError, isConnectionFault, withDeadline } from '@setu-ts/common';
import { SecretProviderUnavailableError } from '../errors.ts';

/** Default `requestTimeoutMs` of the cloud secrets providers (Vault's). */
export const DEFAULT_SECRETS_REQUEST_TIMEOUT_MS = 5000;

/** gRPC status codes that mean the backend did not answer. */
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;

/** The longest cause message copied into a provider-named error. */
const MAX_CAUSE_MESSAGE = 300;

/** The bound one provider applies to each backend call. */
export interface SecretsDeadline {
  readonly timeoutMs: number;
  readonly timing?: DeadlineOptions['timing'];
}

/** The error a call rejects with when its bound expires. */
export class SecretsDeadlineError extends Error {
  override readonly name = 'SecretsDeadlineError';
}

/**
 * Resolves and checks a provider's `requestTimeoutMs`.
 *
 * @param value - The configured value, or `undefined` for the default
 * @param timing - The runtime timer surface
 * @returns The bound
 * @throws {RangeError} When the value is not a finite number in the timer range
 */
export function resolveSecretsDeadline(
  value: number | undefined,
  timing?: DeadlineOptions['timing'],
): SecretsDeadline {
  const timeoutMs = value ?? DEFAULT_SECRETS_REQUEST_TIMEOUT_MS;
  const refusal = deadlineRangeError('requestTimeoutMs', timeoutMs);
  if (refusal !== null) throw refusal;
  return timing === undefined ? { timeoutMs } : { timeoutMs, timing };
}

/**
 * Runs one backend call under the bound. The call receives the deadline's
 * signal for an SDK that accepts one; the deadline races the call either way.
 *
 * @param deadline - The provider's bound
 * @param provider - The provider name, for the expiry message
 * @param run - The backend call
 * @returns The call's value, or a rejection with its error or the deadline's
 */
export function runSecretsCall<T>(
  deadline: SecretsDeadline,
  provider: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withDeadline(run, {
    timeoutMs: deadline.timeoutMs,
    onTimeout: () =>
      new SecretsDeadlineError(`${provider} did not answer within ${deadline.timeoutMs} ms`),
    ...(deadline.timing !== undefined && { timing: deadline.timing }),
  });
}

/**
 * Reads the status a backend answered: an HTTP status (AWS
 * `$metadata.httpStatusCode`, Azure `statusCode`) or a gRPC code (GCP's
 * numeric `code` below 100).
 *
 * @param error - The rejection
 * @returns The answer, or `undefined` when none was given
 */
export function answerOf(
  error: unknown,
): { readonly kind: 'http' | 'grpc'; readonly code: number } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as {
    $metadata?: { httpStatusCode?: unknown };
    statusCode?: unknown;
    code?: unknown;
  };
  for (const status of [record.$metadata?.httpStatusCode, record.statusCode]) {
    if (typeof status === 'number' && status >= 100 && status <= 599) {
      return { kind: 'http', code: status };
    }
  }
  if (typeof record.code === 'number' && record.code >= 0 && record.code < 100) {
    return { kind: 'grpc', code: record.code };
  }
  return undefined;
}

/**
 * Reports whether a rejection means the backend did not answer.
 *
 * @param error - The rejection
 * @returns `true` for an outage
 */
export function isSecretsOutage(error: unknown): boolean {
  if (error instanceof SecretsDeadlineError || isConnectionFault(error)) return true;
  const answer = answerOf(error);
  if (answer === undefined) return false;
  if (answer.kind === 'http') return answer.code >= 500;
  return answer.code === GRPC_UNAVAILABLE || answer.code === GRPC_DEADLINE_EXCEEDED;
}

/**
 * Classifies a provider call's rejection.
 *
 * @param error - The rejection
 * @param provider - The provider name (`AwsKmsProvider`, …)
 * @param operation - `get`, `set` or `probe`
 * @returns The error to throw
 */
export function toSecretsError(error: unknown, provider: string, operation: string): Error {
  if (error instanceof SecretProviderUnavailableError) return error;
  if (isSecretsOutage(error)) return new SecretProviderUnavailableError(provider, error);
  const message = error instanceof Error ? error.message : textOf(error);
  // Control characters (CR/LF, C1 and the Unicode line separators included) are
  // replaced, so a backend's text
  // cannot forge a log line.
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const printable = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return new Error(`${provider} ${operation} failed: ${printable.slice(0, MAX_CAUSE_MESSAGE)}`, {
    cause: error,
  });
}

/**
 * The readiness rule of the cloud secrets probes: the backend answered. A
 * refused credential is an answer (a least-privilege credential may lack the
 * list permission the probe needs); a network failure, the bound, a `5xx` or a
 * gRPC `UNAVAILABLE`/`DEADLINE_EXCEEDED` is not.
 *
 * @param probe - The listing call
 * @returns `true` when the backend answered
 */
export async function answered(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (error) {
    return answerOf(error) !== undefined && !isSecretsOutage(error);
  }
}

/**
 * Text for a non-`Error` rejection; one with no text form (no prototype) gets
 * a fixed description, so the original stays the `cause`.
 *
 * @param value - The rejection
 * @returns Its text
 */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'a value with no text form';
  }
}

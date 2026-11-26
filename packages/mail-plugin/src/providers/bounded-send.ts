/**
 * The one place the HTTP mail providers (SES, SendGrid) bound a call and
 * classify its failure.
 *
 * A send that does not settle within `requestTimeoutMs` rejects with
 * `BackendOutcomeUnknownError` (`504`): the message may already have gone out,
 * so a blind retry risks a duplicate. A refused connection and the other shapes
 * `toBackendFault` recognises answer `503` or `504` by that table, except that
 * a `503` after the SDK retried (`$metadata.attempts` above 1) is a `504`.
 * Anything else is rethrown unchanged.
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

/** Default `requestTimeoutMs` of the HTTP mail providers. */
export const DEFAULT_MAIL_REQUEST_TIMEOUT_MS = 15_000;

/** The bound one provider applies to each call. */
export interface MailDeadline {
  readonly timeoutMs: number;
  readonly timing?: DeadlineOptions['timing'];
}

/** The error a call rejects with when its bound expires. */
export class MailDeadlineError extends Error {
  override readonly name = 'MailDeadlineError';
}

/**
 * Resolves and checks a provider's `requestTimeoutMs`.
 *
 * @param value - The configured value, or `undefined` for the default
 * @param timing - The runtime timer surface
 * @returns The bound
 * @throws {RangeError} When the value is not a finite number in the timer range
 */
export function resolveMailDeadline(
  value: number | undefined,
  timing?: DeadlineOptions['timing'],
): MailDeadline {
  const timeoutMs = value ?? DEFAULT_MAIL_REQUEST_TIMEOUT_MS;
  const refusal = deadlineRangeError('requestTimeoutMs', timeoutMs);
  if (refusal !== null) throw refusal;
  return timing === undefined ? { timeoutMs } : { timeoutMs, timing };
}

/**
 * Runs one call under the bound; the call receives the deadline's signal.
 *
 * @param deadline - The provider's bound
 * @param provider - The provider name, for the expiry message
 * @param run - The call
 * @returns The call's value, or a rejection with its error or the deadline's
 */
export function runMailCall<T>(
  deadline: MailDeadline,
  provider: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withDeadline(run, {
    timeoutMs: deadline.timeoutMs,
    onTimeout: () =>
      new MailDeadlineError(
        `mail-plugin (${provider}): send did not answer within ${deadline.timeoutMs} ms`,
      ),
    ...(deadline.timing !== undefined && { timing: deadline.timing }),
  });
}

/**
 * Classifies a send failure: an expired bound is `504`; a shape
 * `toBackendFault` knows is `503` or `504`; any other `Error` is returned as
 * is (a thrown non-`Error` is wrapped so the caller always throws an `Error`).
 *
 * @param error - The rejection
 * @param provider - The provider name (`ses`, `sendgrid`)
 * @returns The error to throw
 */
export function toMailError(error: unknown, provider: string): Error {
  const label = `mail-plugin (${provider}): send`;
  if (error instanceof MailDeadlineError) {
    return new BackendOutcomeUnknownError(label, { cause: error });
  }
  const fault = toBackendFault(error, label);
  // The SES client retries a reset or refused connection on its own
  // (`$metadata.attempts` records it): a refusal after a retry may follow an
  // attempt that delivered, so it is outcome-unknown, not "not sent".
  if (fault instanceof BackendUnavailableError && sdkAttempts(error) > 1) {
    return new BackendOutcomeUnknownError(label, { cause: error });
  }
  return fault ?? (error instanceof Error ? error : new Error(textOf(error)));
}

/**
 * The attempts an SDK made before it rejected (`$metadata.attempts`), `1` when
 * it records none.
 *
 * @param error - The rejection
 * @returns The attempt count
 */
function sdkAttempts(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 1;
  const attempts = (error as { $metadata?: { attempts?: unknown } }).$metadata?.attempts;
  return typeof attempts === 'number' && attempts > 1 ? attempts : 1;
}

/**
 * Text for a non-`Error` rejection; one with no text form (no prototype) gets
 * a fixed description instead of a `TypeError`.
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

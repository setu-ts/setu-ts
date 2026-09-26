/**
 * Turns whatever a processor, adapter or metrics backend threw into an `Error`
 * that is safe to report — and never throws while doing so.
 *
 * A thrown value is caller-controlled: a processor can rethrow a payload-derived
 * object whose `toString` is not a function (`{ toString: 1 }`) or a revoked
 * `Proxy`, on which even `instanceof` throws. Converting it with a bare
 * `new Error(String(error))` then throws INSIDE the failure path, which escaped
 * `runJob` before the job was requeued or dead-lettered and left it stuck in
 * its processing state for the life of the process. The report is only a
 * signal; losing its detail must never cost the job.
 *
 * @module
 */

/** The fixed message for a thrown value that cannot be described. */
export const UNDESCRIBABLE_ERROR_MESSAGE =
  'A non-Error value was thrown and could not be described.';

/**
 * Returns the thrown value itself when it is an `Error`, otherwise an `Error`
 * carrying its string form, or a fixed message when neither can be obtained.
 *
 * @param error - The thrown value
 * @returns An `Error` safe to hand to a reporter
 * @internal
 */
export function toReportableError(error: unknown): Error {
  try {
    return error instanceof Error ? error : new Error(String(error));
  } catch {
    return new Error(UNDESCRIBABLE_ERROR_MESSAGE);
  }
}

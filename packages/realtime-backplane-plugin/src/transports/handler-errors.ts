/**
 * Bounded subscriber-error history shared by the backplane transports.
 * Internal: not exported from the package barrel.
 *
 * @module
 */

const MAX_HANDLER_ERRORS = 100;

/**
 * Appends a thrown value, retaining the most recent 100 errors, oldest first.
 *
 * @param errors - The transport's history, mutated in place
 * @param error - The value thrown by a subscriber
 */
export function recordHandlerError(errors: Error[], error: unknown): void {
  errors.push(error instanceof Error ? error : new Error(String(error)));
  if (errors.length > MAX_HANDLER_ERRORS) {
    errors.splice(0, errors.length - MAX_HANDLER_ERRORS);
  }
}

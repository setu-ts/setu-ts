/**
 * Bounded subscriber-error history shared by the backplane transports.
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import type { IRealtimeHandlerErrorReporter } from '@setu-ts/common';
import { describeError } from '@setu-ts/common';

const MAX_HANDLER_ERRORS = 100;

/**
 * Appends a thrown value, retaining the most recent 100 errors, oldest first.
 *
 * @param errors - The transport's history, mutated in place
 * @param error - The value thrown by a subscriber
 */
export function recordHandlerError(errors: Error[], error: unknown): void {
  let recorded: Error;
  try {
    recorded = error instanceof Error ? error : new Error(String(error));
  } catch {
    // Non-coercible rejection values must not make the history sink reject.
    recorded = new Error(describeError(error));
  }
  errors.push(recorded);
  if (errors.length > MAX_HANDLER_ERRORS) {
    errors.splice(0, errors.length - MAX_HANDLER_ERRORS);
  }
}

/** Combines the bounded transport history with an optional application sink. */
export function createTransportHandlerReporter(
  errors: Error[],
  reporter?: IRealtimeHandlerErrorReporter,
): IRealtimeHandlerErrorReporter {
  return {
    failed(handler, error, frame): void {
      recordHandlerError(errors, error);
      reporter?.failed(handler, error, frame);
    },
    succeeded(handler): void {
      reporter?.succeeded(handler);
    },
  };
}

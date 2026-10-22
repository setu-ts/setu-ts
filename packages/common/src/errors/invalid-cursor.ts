/** Portable refusal of client cursor content. @module */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * A malformed cursor or a cursor incompatible with the requested query.
 * The served detail never identifies a backend, entity or cursor value.
 *
 * @example
 * ```typescript
 * if (error instanceof InvalidCursorError) {
 *   // Restart the pagination walk without the rejected cursor.
 * }
 * ```
 * @since 0.10.0
 */
export class InvalidCursorError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'InvalidCursorError';

  /**
   * @param message - A diagnostic naming the entity and check, never cursor content
   * @param options - Standard error options; `cause` keeps a scrubbed driver error for the log
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The pagination cursor is not valid for this query.',
    });
  }
}

/** Portable field type refusal. @module */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * The database refused a supplied value for its field type.
 * No supplied key, field or value is included in the diagnostic or HTTP detail.
 * @example
 * ```typescript
 * if (error instanceof InvalidFieldValueError) {
 *   // Correct the request's field types before retrying.
 * }
 * ```
 * @since 0.11.0
 */
export class InvalidFieldValueError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'InvalidFieldValueError';
  /**
   * @param entity - The addressed entity
   * @param options - The scrubbed driver error as cause
   */
  constructor(entity: string, options?: ErrorOptions) {
    super(`Entity '${entity}': the database refused a supplied value for its field type.`, options);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'A supplied value does not fit the type of its field.',
    });
  }
}

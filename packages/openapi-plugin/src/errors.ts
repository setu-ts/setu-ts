/**
 * Refuses a blank or duplicate declared operation id in the included routes.
 *
 * @example
 * ```typescript
 * if (error instanceof OperationIdError && error.reason === 'duplicate') {
 *   // Give the routes distinct schema.operationId values.
 * }
 * ```
 * @since 0.10.0
 */
export class OperationIdError extends Error {
  /** Why the declared operation id was refused. */
  readonly reason: 'duplicate' | 'blank';

  /**
   * Creates a refusal with a diagnostic naming the id and affected routes.
   *
   * @param reason - Whether the id is duplicated or blank
   * @param message - Diagnostic containing the developer-written id and routes
   */
  constructor(reason: 'duplicate' | 'blank', message: string) {
    super(message);
    this.name = 'OperationIdError';
    this.reason = reason;
  }
}

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

/**
 * Refuses document metadata that violates OpenAPI 3.1 object constraints.
 *
 * @example
 * ```typescript
 * if (error instanceof OpenApiDocumentOptionsError && error.reason === 'duplicate-tag') {
 *   // Give every document tag a distinct name.
 * }
 * ```
 * @since 0.13.0
 */
export class OpenApiDocumentOptionsError extends Error {
  /**
   * The document metadata constraint that was violated.
   * @since 0.13.0
   */
  readonly reason: 'license-identifier-and-url' | 'duplicate-tag' | 'error-schema';

  /**
   * Creates a refusal naming the invalid metadata.
   * @param reason - The violated constraint
   * @param message - Diagnostic naming the conflicting keys or tag
   * @since 0.13.0
   */
  constructor(
    reason: 'license-identifier-and-url' | 'duplicate-tag' | 'error-schema',
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiDocumentOptionsError';
    this.reason = reason;
  }
}

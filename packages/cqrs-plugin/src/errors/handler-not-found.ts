/**
 * Error thrown when no handler is registered for a request type.
 *
 * @module
 */

/**
 * Thrown by {@linkcode CommandBus.execute} and {@linkcode QueryBus.execute}
 * when no handler is registered for the request's `type`.
 *
 * @since 0.1.0
 */
export class HandlerNotFoundError extends Error {
  /** The request type that had no handler. */
  readonly requestType: string;

  /**
   * Creates a new error.
   *
   * @param requestType - The request type name
   */
  constructor(requestType: string) {
    super(`No handler registered for request type '${requestType}'.`);
    this.name = 'HandlerNotFoundError';
    this.requestType = requestType;
  }
}

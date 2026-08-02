/**
 * GraphQL plugin error classes.
 *
 * @module
 */

/**
 * Error thrown when schema construction or resolver attachment fails.
 */
export class GraphqlSchemaError extends Error {
  override name = 'GraphqlSchemaError';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Error thrown when the graphql runtime cannot be loaded.
 */
export class GraphqlRuntimeLoadError extends Error {
  override name = 'GraphqlRuntimeLoadError';

  /**
   * The specifier that failed to load.
   */
  specifier: string;

  constructor(specifier: string, cause: unknown) {
    const message = `Failed to load graphql runtime from "${specifier}". ` +
      `Install with: deno add npm:graphql@^16`;
    super(message, { cause });
    this.specifier = specifier;
  }
}

/**
 * OpenAPI service interface for generating and retrieving OpenAPI specifications.
 *
 * @module
 */

/**
 * Service for generating and retrieving OpenAPI 3.1 specifications.
 *
 * @since 0.1.0
 */
export interface IOpenApiService {
  /**
   * Returns the generated OpenAPI 3.1 document.
   *
   * Builds the spec lazily on first call and caches it for subsequent calls.
   *
   * @returns The complete OpenAPI document as a readonly record
   */
  getSpec(): Readonly<Record<string, unknown>>;
}

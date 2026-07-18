import type { IApplication } from '@hono-enterprise/common';

import type { OpenApiDocument, OpenApiGeneratorOptions } from '../generators/openapi-generator.ts';
import { OpenApiGenerator } from '../generators/openapi-generator.ts';
import type { IOpenApiService } from '../interfaces/openapi-service.ts';

/**
 * Options for the OpenAPI service.
 *
 * @since 0.1.0
 */
export interface OpenApiServiceOptions extends OpenApiGeneratorOptions {
  /** The application context for accessing routes. */
  readonly app: IApplication;
  /** Pre-registered schemas from other plugins. */
  readonly schemas?: readonly {
    readonly name: string;
    readonly schema: unknown;
  }[];
}

/**
 * Service for generating and caching OpenAPI specifications.
 *
 * @since 0.1.0
 */
export class OpenApiService implements IOpenApiService {
  readonly #options: OpenApiServiceOptions;
  #generator: OpenApiGenerator | null = null;
  #cachedSpec: OpenApiDocument | null = null;

  /**
   * Builds generator options from service options, omitting undefined fields.
   */
  #makeGeneratorOptions(): OpenApiGeneratorOptions {
    const base: Record<string, unknown> = {
      title: this.#options.title ?? 'API',
      version: this.#options.version ?? '1.0.0',
    };
    if (this.#options.description !== undefined) base.description = this.#options.description;
    if (this.#options.servers !== undefined) base.servers = this.#options.servers;
    if (this.#options.securitySchemes !== undefined) {
      base.securitySchemes = this.#options.securitySchemes;
    }
    return base as OpenApiGeneratorOptions;
  }

  /**
   * Creates a new OpenAPI service.
   *
   * @param options - Service options
   */
  constructor(options: OpenApiServiceOptions) {
    this.#options = options;

    // Register pre-registered schemas immediately in the generator (lazy-create it)
    // so they are present regardless of whether addSchema() is called before getSpec().
    if (options.schemas && options.schemas.length > 0) {
      this.#generator = new OpenApiGenerator(this.#makeGeneratorOptions());
      for (const { name, schema } of options.schemas) {
        this.#generator.addSchema(name, schema);
      }
    }
  }

  /**
   * Returns the generated OpenAPI specification.
   *
   * Builds the spec lazily on first call and caches it for subsequent calls.
   *
   * @returns The complete OpenAPI document
   */
  getSpec(): Readonly<Record<string, unknown>> {
    if (!this.#cachedSpec) {
      this.#cachedSpec = this.#buildSpec();
    }
    return this.#cachedSpec as unknown as Readonly<Record<string, unknown>>;
  }

  /**
   * Registers a named schema for deduplication.
   *
   * @param name - Schema name
   * @param schema - The schema to register
   */
  addSchema(name: string, schema: unknown): void {
    // Initialize generator if not already created
    if (!this.#generator) {
      this.#generator = new OpenApiGenerator(this.#makeGeneratorOptions());
    }
    // Invalidate cache when new schemas are added
    this.#cachedSpec = null;
    this.#generator.addSchema(name, schema);
  }

  /**
   * Builds the OpenAPI specification from registered routes.
   *
   * @returns The complete OpenAPI document
   */
  #buildSpec(): OpenApiDocument {
    // Create generator with options (once, lazily) — only if not already created
    // (constructor may have created it if schemas were provided)
    if (!this.#generator) {
      this.#generator = new OpenApiGenerator(this.#makeGeneratorOptions());
    }

    // Get routes from the application
    const routes = this.#options.app.router.listRoutes();

    // Generate the document
    return this.#generator.generate(routes);
  }
}

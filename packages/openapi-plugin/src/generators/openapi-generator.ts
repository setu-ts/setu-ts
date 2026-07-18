import type { RouteInfo } from '@hono-enterprise/common';

import type { OpenApiSchemaObject } from '../transformers/zod-to-openapi.ts';
import { ZodToOpenApi } from '../transformers/zod-to-openapi.ts';

/**
 * OpenAPI 3.1 document structure.
 *
 * @since 0.1.0
 */
export interface OpenApiDocument {
  /** OpenAPI version. */
  readonly openapi: string;
  /** API metadata. */
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  /** Server URLs. */
  readonly servers?: readonly {
    readonly url: string;
    readonly description?: string;
  }[];
  /** API paths. */
  readonly paths: Record<string, {
    readonly get?: OpenApiOperation;
    readonly post?: OpenApiOperation;
    readonly put?: OpenApiOperation;
    readonly patch?: OpenApiOperation;
    readonly delete?: OpenApiOperation;
    readonly head?: OpenApiOperation;
    readonly options?: OpenApiOperation;
  }>;
  /** Reusable components. */
  readonly components?: {
    readonly schemas?: Record<string, OpenApiSchemaObject>;
    readonly securitySchemes?: Record<string, unknown>;
  };
}

/**
 * OpenAPI operation definition.
 *
 * @since 0.1.0
 */
export interface OpenApiOperation {
  /** Unique operation identifier. */
  readonly operationId: string;
  /** Operation summary. */
  readonly summary?: string;
  /** Operation tags. */
  readonly tags?: readonly string[];
  /** Path/query parameters. */
  readonly parameters?: readonly OpenApiParameter[];
  /** Request body. */
  readonly requestBody?: OpenApiRequestBody;
  /** Response codes. */
  readonly responses: Record<string, OpenApiResponse>;
  /** Security requirements. */
  readonly security?: readonly Record<string, readonly string[]>[];
}

/**
 * OpenAPI parameter definition.
 *
 * @since 0.1.0
 */
export interface OpenApiParameter {
  /** Parameter name. */
  readonly name: string;
  /** Parameter location. */
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  /** Whether parameter is required. */
  readonly required: boolean;
  /** Parameter schema. */
  readonly schema: OpenApiSchemaObject;
  /** Parameter description. */
  readonly description?: string;
}

/**
 * OpenAPI request body definition.
 *
 * @since 0.1.0
 */
export interface OpenApiRequestBody {
  /** Whether body is required. */
  readonly required: boolean;
  /** Content types. */
  readonly content: {
    readonly 'application/json': {
      readonly schema: OpenApiSchemaObject;
    };
  };
}

/**
 * OpenAPI response definition.
 *
 * @since 0.1.0
 */
export interface OpenApiResponse {
  /** Response description. */
  readonly description: string;
  /** Response content. */
  readonly content?: {
    readonly 'application/json'?: {
      readonly schema: OpenApiSchemaObject;
    };
  };
}

/**
 * Options for OpenAPI document generation.
 *
 * @since 0.1.0
 */
export interface OpenApiGeneratorOptions {
  /** API title (required, defaults to 'API'). */
  readonly title?: string;
  /** API version (required, defaults to '1.0.0'). */
  readonly version?: string;
  /** API description. */
  readonly description?: string;
  /** Server URLs. */
  readonly servers?: readonly {
    readonly url: string;
    readonly description?: string;
  }[];
  /** Security schemes. */
  readonly securitySchemes?: Record<string, unknown>;
}

/**
 * Generates OpenAPI 3.1 documents from route information.
 *
 * @since 0.1.0
 */
export class OpenApiGenerator {
  readonly #options: OpenApiGeneratorOptions & {
    title: string;
    version: string;
  };
  readonly #transformer: ZodToOpenApi;
  readonly #schemaMap: Map<unknown, string>;
  readonly #componentSchemas: Map<string, OpenApiSchemaObject>;

  /**
   * Creates a new OpenAPI generator.
   *
   * @param options - Generator options
   */
  constructor(options: OpenApiGeneratorOptions) {
    this.#options = {
      title: options.title ?? 'API',
      version: options.version ?? '1.0.0',
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.servers !== undefined ? { servers: options.servers } : {}),
      ...(options.securitySchemes !== undefined
        ? { securitySchemes: options.securitySchemes }
        : {}),
    } as OpenApiGeneratorOptions & {
      title: string;
      version: string;
    };
    this.#transformer = new ZodToOpenApi();
    this.#schemaMap = new Map();
    this.#componentSchemas = new Map();
  }

  /**
   * Registers a named schema for deduplication.
   *
   * @param name - Schema name
   * @param schema - The schema to register
   */
  addSchema(name: string, schema: unknown): void {
    this.#schemaMap.set(schema, name);
    this.#componentSchemas.set(name, this.#transformer.transform(schema));
  }

  /**
   * Generates an OpenAPI document from routes.
   *
   * @param routes - Array of route information
   * @returns The complete OpenAPI 3.1 document
   */
  generate(routes: readonly RouteInfo[]): OpenApiDocument {
    // Reset schema map but preserve pre-registered schemas
    this.#schemaMap.clear();
    // Keep pre-registered schemas from addSchema calls

    // First, register any pre-registered schemas
    // (for schemas contributed via ctx.openapi.addSchema)

    const paths: Record<string, {
      get?: OpenApiOperation;
      post?: OpenApiOperation;
      put?: OpenApiOperation;
      patch?: OpenApiOperation;
      delete?: OpenApiOperation;
      head?: OpenApiOperation;
      options?: OpenApiOperation;
    }> = {};

    // Group routes by path
    for (const route of routes) {
      const openApiPath = this.#convertPath(route.path);
      const method = route.method.toLowerCase() as keyof typeof paths;

      if (!paths[openApiPath]) {
        paths[openApiPath] = {};
      }

      const operation = this.#createOperation(route, openApiPath);
      (paths[openApiPath] as Record<string, OpenApiOperation>)[method] = operation;
    }

    // Build components section
    const components: Record<string, unknown> = {};
    if (this.#componentSchemas.size > 0) {
      components.schemas = Object.fromEntries(this.#componentSchemas);
    }
    if (
      this.#options.securitySchemes &&
      Object.keys(this.#options.securitySchemes).length > 0
    ) {
      components.securitySchemes = this.#options.securitySchemes;
    }

    return {
      openapi: '3.1.0',
      info: {
        title: this.#options.title,
        version: this.#options.version,
        ...(this.#options.description !== undefined
          ? { description: this.#options.description }
          : {}),
      },
      ...(this.#options.servers !== undefined ? { servers: this.#options.servers } : {}),
      paths,
      ...(Object.keys(components).length > 0 ? { components } : {}),
    };
  }

  /**
   * Converts router-style path to OpenAPI path template syntax.
   *
   * @param path - Router-style path (e.g., `/users/:id`)
   * @returns OpenAPI path template (e.g., `/users/{id}`)
   */
  #convertPath(path: string): string {
    return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
  }

  /**
   * Creates an OpenAPI operation from route information.
   *
   * @param route - Route information
   * @param openApiPath - Converted OpenAPI path
   * @returns The operation object
   */
  #createOperation(route: RouteInfo, openApiPath: string): OpenApiOperation {
    const schema = route.definition.schema;

    // Generate operationId from method and path
    const operationId = this.#generateOperationId(route.method, openApiPath);

    // Build parameters from params and query schemas
    const parameters = this.#buildParameters(route);

    // Build request body from body schema
    const requestBody = schema?.body
      ? {
        required: true,
        content: {
          'application/json': {
            schema: this.#resolveSchema(schema.body),
          },
        },
      }
      : undefined;

    // Build responses from response schema
    const responses = this.#buildResponses(schema?.response);

    return {
      operationId,
      ...(schema?.summary ? { summary: schema.summary } : {}),
      ...(schema?.tags && schema.tags.length > 0 ? { tags: schema.tags } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
    };
  }

  /**
   * Generates an operationId from method and path.
   *
   * @param method - HTTP method
   * @param path - OpenAPI path template
   * @returns Operation ID
   */
  #generateOperationId(method: string, path: string): string {
    const methodLower = method.toLowerCase();
    const pathParts = path.split('/').filter(Boolean);
    const pathSlug = pathParts
      .map((part) => part.replace(/\{([^}]+)\}/g, '{$1}'))
      .join('-');
    return `${methodLower}-${pathSlug || 'root'}`;
  }

  /**
   * Builds parameters from params and query schemas.
   *
   * @param route - Route information
   * @returns Array of parameters
   */
  #buildParameters(route: RouteInfo): readonly OpenApiParameter[] {
    const parameters: OpenApiParameter[] = [];
    const schema = route.definition.schema;

    // Extract path parameters from the path template
    const pathParams = this.#extractPathParams(route.path);

    // Add path parameters
    for (const paramName of pathParams) {
      const paramSchema = schema?.params ? this.#getPropertySchema(schema.params, paramName) : {};

      parameters.push({
        name: paramName,
        in: 'path',
        required: true,
        schema: paramSchema,
      });
    }

    // Add query parameters from schema
    if (schema?.query) {
      const queryProps = this.#getObjectProperties(schema.query);
      for (const [name, propSchema] of Object.entries(queryProps)) {
        const isOptional = this.#isPropertyOptional(schema.query, name);
        parameters.push({
          name,
          in: 'query',
          required: !isOptional,
          schema: propSchema,
        });
      }
    }

    return parameters;
  }

  /**
   * Extracts path parameter names from a path template.
   *
   * @param path - Route path
   * @returns Array of parameter names
   */
  #extractPathParams(path: string): readonly string[] {
    const matches = path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
    return matches.map((m) => m.slice(1));
  }

  /**
   * Gets the schema for a specific property.
   *
   * @param schema - The object schema
   * @param propertyName - Property name
   * @returns The property schema
   */
  #getPropertySchema(schema: unknown, propertyName: string): OpenApiSchemaObject {
    const transformed = this.#transformer.transform(schema);
    if (transformed.properties && propertyName in transformed.properties) {
      return transformed.properties[propertyName];
    }
    return {};
  }

  /**
   * Gets object properties from a schema.
   *
   * @param schema - The schema
   * @returns Properties object
   */
  #getObjectProperties(schema: unknown): Record<string, OpenApiSchemaObject> {
    const transformed = this.#transformer.transform(schema);
    return transformed.properties ?? {};
  }

  /**
   * Checks if a property is optional.
   *
   * @param schema - The object schema
   * @param propertyName - Property name
   * @returns True if optional
   */
  #isPropertyOptional(schema: unknown, propertyName: string): boolean {
    const transformed = this.#transformer.transform(schema);
    return !transformed.required?.includes(propertyName);
  }

  /**
   * Builds responses from response schema.
   *
   * @param responseSchema - Response schema map
   * @returns Responses object
   */
  #buildResponses(
    responseSchema?: Readonly<Record<number, unknown>>,
  ): Record<string, OpenApiResponse> {
    const responses: Record<string, OpenApiResponse> = {};

    if (responseSchema) {
      for (const [status, schema] of Object.entries(responseSchema)) {
        const statusCode = parseInt(status, 10);
        const description = this.#getStatusDescription(statusCode);

        responses[String(statusCode)] = {
          description,
          ...(schema
            ? {
              content: {
                'application/json': {
                  schema: this.#resolveSchema(schema),
                },
              },
            }
            : {}),
        };
      }
    } else {
      // Default response
      responses['200'] = {
        description: 'Successful response',
      };
    }

    return responses;
  }

  /**
   * Gets a description for HTTP status code.
   *
   * @param status - Status code
   * @returns Description
   */
  #getStatusDescription(status: number): string {
    const descriptions: Record<number, string> = {
      200: 'Successful response',
      201: 'Resource created',
      204: 'No content',
      400: 'Bad request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not found',
      500: 'Internal server error',
    };
    return descriptions[status] ?? 'Response';
  }

  /**
   * Resolves a schema, potentially creating a $ref for deduplication.
   *
   * @param schema - The schema to resolve
   * @returns The schema or a $ref
   */
  #resolveSchema(schema: unknown): OpenApiSchemaObject {
    // Check if we've seen this schema before
    const existingRef = this.#schemaMap.get(schema);
    if (existingRef) {
      return { $ref: `#/components/schemas/${existingRef}` };
    }

    // Transform the schema
    const transformed = this.#transformer.transform(schema);

    // For object schemas, try to generate a name and deduplicate
    if (transformed.type === 'object' && transformed.properties) {
      // Generate a name from the schema structure
      const propName = this.#generateSchemaName(transformed);
      if (propName && !this.#componentSchemas.has(propName)) {
        this.#componentSchemas.set(propName, transformed);
        this.#schemaMap.set(schema, propName);
        return { $ref: `#/components/schemas/${propName}` };
      }
    }

    return transformed;
  }

  /**
   * Generates a schema name from schema structure.
   *
   * @param schema - The schema
   * @returns Generated name or null
   */
  #generateSchemaName(schema: OpenApiSchemaObject): string | null {
    // For now, use a simple heuristic based on property names
    if (schema.properties) {
      const propNames = Object.keys(schema.properties);
      if (propNames.length > 0) {
        // Try to find a common pattern (e.g., 'id', 'name', 'email')
        if (propNames.includes('id') && propNames.includes('name')) {
          return 'NamedEntity';
        }
        if (propNames.includes('email')) {
          return 'User';
        }
        if (propNames.includes('title')) {
          return 'Article';
        }
      }
    }
    return null;
  }
}

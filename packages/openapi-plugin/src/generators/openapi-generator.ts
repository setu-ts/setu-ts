import type { RouteInfo, SecurityRequirement } from '@setu-ts/common';
import { securityMetadataOf } from '@setu-ts/common';

import type { OpenApiSchemaObject } from '../transformers/zod-to-openapi.ts';
import { ZodToOpenApi } from '../transformers/zod-to-openapi.ts';

/**
 * Schema emitted for a path parameter the route's `params` schema does not
 * describe: every path segment arrives as a string.
 *
 * A FRESH object per parameter, deliberately, not a shared constant.
 * {@linkcode OpenApiSchemaObject} declares mutable fields and
 * {@linkcode OpenApiDocument} is public API, so a consumer post-processing the
 * generated document is entitled to assign to one — a shared instance would
 * either alias every path parameter in the process or, if frozen, throw a
 * `TypeError` on a legitimate write.
 *
 * @returns A new default path-parameter schema
 */
function defaultPathParamSchema(): OpenApiSchemaObject {
  return { type: 'string' };
}

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
  /**
   * Document-level security requirements, applied to every operation that
   * does not declare its own. An operation opts out with `security: []`.
   */
  readonly security?: readonly SecurityRequirement[];
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
  /**
   * Security requirements for this operation — declared on the route's
   * `schema.security`, or derived from its branded guards when
   * {@linkcode OpenApiGeneratorOptions.deriveSecurity} is configured
   * (declared wins). Absent when neither applies, which leaves the operation
   * inheriting the document-level requirement; an empty array marks it public,
   * overriding that default.
   */
  readonly security?: readonly SecurityRequirement[];
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
  /**
   * Document-level security requirements, inherited by every operation whose
   * route does not declare `schema.security`. Names must match keys of
   * {@linkcode OpenApiGeneratorOptions.securitySchemes}.
   */
  readonly security?: readonly SecurityRequirement[];
  /**
   * Derives each operation's security requirement from the guards actually
   * protecting its route, instead of requiring every route to declare one.
   *
   * A guard brands itself with `RouteSecurityMetadata` (every guard
   * `@setu-ts/auth-plugin` ships does); when this option is set, a route
   * carrying a guard that requires authentication is documented as needing
   * `scheme`, and one carrying a guard that marks it public is documented with
   * an empty requirement.
   *
   * `scheme` must be a key of {@linkcode OpenApiGeneratorOptions.securitySchemes} —
   * a guard cannot know what the document calls its scheme, so the name is
   * configured here rather than inferred.
   *
   * Only ROUTE-level middleware is inspected. Middleware added through
   * `app.middleware.add()` is not visible on a route and is not consulted;
   * that is correct for `authMiddleware()`, which populates the principal
   * rather than enforcing anything.
   *
   * A requirement declared on the route's own `schema.security` always wins.
   *
   * @defaultValue undefined — nothing is derived
   */
  readonly deriveSecurity?: { readonly scheme: string };
  /**
   * Router paths to leave out of the generated document.
   *
   * Matched exactly against the **fully-resolved** router pattern, which is
   * router-style rather than an OpenAPI template (`/todos/:id`, not
   * `/todos/{id}`) and INCLUDES any `router.group()` prefix — a route
   * registered as `get('/metrics')` inside `group('/internal', …)` is matched
   * only by `'/internal/metrics'`. Every method registered on an excluded path
   * is omitted. An entry matching no route is silently ignored.
   */
  readonly exclude?: readonly string[];
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
  /**
   * Excluded router paths as a set, built once at construction so
   * {@linkcode generate} costs a lookup per route rather than a scan.
   */
  readonly #excluded: ReadonlySet<string>;
  readonly #schemaMap: Map<unknown, string>;
  readonly #componentSchemas: Map<string, OpenApiSchemaObject>;
  readonly #seenSchemas: Set<unknown>;
  #anonymousSchemaCounter: number;

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
      ...(options.security !== undefined ? { security: options.security } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(options.deriveSecurity !== undefined ? { deriveSecurity: options.deriveSecurity } : {}),
    } as OpenApiGeneratorOptions & {
      title: string;
      version: string;
    };
    this.#excluded = new Set(options.exclude ?? []);
    this.#transformer = new ZodToOpenApi();
    this.#schemaMap = new Map();
    this.#componentSchemas = new Map();
    this.#seenSchemas = new Set();
    this.#anonymousSchemaCounter = 0;
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
    // Do NOT clear #schemaMap - pre-registered schemas from addSchema must persist
    // so #resolveSchema finds them by object identity and emits the contributor's chosen name

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
      // Excluded paths are dropped for every method registered on them. The
      // plugin's own `/docs` and `/openapi.json` arrive here pre-excluded, so
      // a document never advertises the endpoints that serve it.
      if (this.#excluded.has(route.path)) continue;

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
      ...(this.#options.security !== undefined ? { security: this.#options.security } : {}),
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
      // Precedence: a DECLARED requirement wins, then a DERIVED one, then
      // nothing — which leaves the operation inheriting the document-level
      // default. The declared test is deliberately `!== undefined` rather than
      // a length check, because an empty array is the specification's way of
      // marking an operation public and is what lets a route opt out.
      ...(schema?.security !== undefined
        ? { security: schema.security }
        : this.#deriveSecurity(route)),
    };
  }

  /**
   * Derives an operation's security requirement from the guards on its route.
   *
   * Returns a spreadable fragment rather than a value so the caller can splice
   * it in without a second `undefined` check: `{}` contributes no `security`
   * key at all, which is what lets the document-level default apply.
   *
   * `authenticated: true` wins over `false` when both are present, because
   * that is what the middleware chain does — `publicRoute()` only calls
   * `next()`, so a route carrying it alongside `requireAuth()` still rejects
   * an anonymous caller.
   *
   * @param route - The route being documented
   * @returns `{ security }` when a requirement was derived, else `{}`
   */
  #deriveSecurity(route: RouteInfo): { security?: readonly SecurityRequirement[] } {
    const derive = this.#options.deriveSecurity;
    if (derive === undefined) return {};

    let sawBrand = false;
    let authenticated = false;
    for (const middleware of route.definition.middleware ?? []) {
      const metadata = securityMetadataOf(middleware);
      if (metadata === undefined) continue;
      sawBrand = true;
      if (metadata.authenticated) authenticated = true;
    }

    if (!sawBrand) return {};
    return { security: authenticated ? [{ [derive.scheme]: [] }] : [] };
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
    const pathSlug = path.split('/').filter(Boolean).join('-');
    return `${methodLower}-${pathSlug || 'root'}`;
  }

  /**
   * Builds parameters from the route's `params`, `query`, and `headers`
   * schemas, in that order.
   *
   * @param route - Route information
   * @returns Array of parameters
   */
  #buildParameters(route: RouteInfo): readonly OpenApiParameter[] {
    const parameters: OpenApiParameter[] = [];
    const schema = route.definition.schema;

    // Extract path parameters from the path template
    const pathParams = this.#extractPathParams(route.path);

    // Hoist transform of params schema to avoid repeated transforms
    let paramsTransformed: Record<string, OpenApiSchemaObject> | undefined;
    if (schema?.params) {
      const paramsObj = this.#transformer.transform(schema.params);
      paramsTransformed = paramsObj.properties ?? {};
    }

    // Add path parameters. A path parameter with no entry in the route's
    // `params` schema falls back to `{ type: 'string' }` rather than the empty
    // schema, which OpenAPI reads as "any type": every path segment arrives as
    // a string, so an untyped parameter renders as `any` in Swagger UI and
    // generates an `unknown` argument in client codegen for no reason.
    for (const paramName of pathParams) {
      const paramSchema = paramsTransformed && paramName in paramsTransformed
        ? paramsTransformed[paramName]
        : defaultPathParamSchema();

      parameters.push({
        name: paramName,
        in: 'path',
        required: true,
        schema: paramSchema,
      });
    }

    // Hoist transform of query schema to avoid repeated transforms
    if (schema?.query) {
      const queryObj = this.#transformer.transform(schema.query);
      const queryProps = queryObj.properties ?? {};
      const queryRequired = queryObj.required ?? [];
      for (const [name, propSchema] of Object.entries(queryProps)) {
        const isOptional = !queryRequired.includes(name);
        parameters.push({
          name,
          in: 'query',
          required: !isOptional,
          schema: propSchema,
        });
      }
    }

    // Header parameters, from the route's `headers` schema. Emitted verbatim:
    // per OpenAPI 3.1, tooling ignores definitions named `Accept`,
    // `Content-Type`, and `Authorization`, so filtering them here would only
    // hide what the route actually declared.
    if (schema?.headers) {
      const headerObj = this.#transformer.transform(schema.headers);
      const headerProps = headerObj.properties ?? {};
      const headerRequired = headerObj.required ?? [];
      for (const [name, propSchema] of Object.entries(headerProps)) {
        parameters.push({
          name,
          in: 'header',
          required: headerRequired.includes(name),
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
      for (const [status, value] of Object.entries(responseSchema)) {
        const statusCode = parseInt(status, 10);
        const { schema, description } = this.#normalizeResponse(value, statusCode);

        responses[String(statusCode)] = {
          description,
          ...(schema !== undefined
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
   * Normalizes a response schema value into a schema + description pair.
   *
   * Programmatic routes store the response schema directly (a Zod schema,
   * identified by its `_def`). Decorator routes (`@ApiResponse`) store a
   * `{ schema?, description? }` wrapper (`buildResponseSchemas` in the
   * decorator plugin); this unwraps that shape so the inner schema is
   * transformed instead of collapsing to `{}`, and prefers the
   * decorator-provided description over the status-code default.
   *
   * @param value - The raw response schema value from `RouteSchema.response`
   * @param statusCode - The HTTP status code (for the default description)
   * @returns The inner schema (if any) and the resolved description
   */
  #normalizeResponse(
    value: unknown,
    statusCode: number,
  ): { schema: unknown; description: string } {
    const fallback = this.#getStatusDescription(statusCode);

    if (value === null || typeof value !== 'object') {
      // Falsy / non-object — no schema to render.
      return { schema: undefined, description: fallback };
    }

    // Bare Zod schema (programmatic convention) — identified by `_def`.
    if ('_def' in value) {
      return { schema: value, description: fallback };
    }

    // Decorator `{ schema?, description? }` wrapper.
    const wrapper = value as { schema?: unknown; description?: unknown };
    const description = typeof wrapper.description === 'string' ? wrapper.description : fallback;
    return { schema: wrapper.schema, description };
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
   * Anonymous schemas used more than once get a generated name (Schema<n>)
   * on first reuse and are hoisted to components/schemas; schemas used
   * exactly once are inlined.
   *
   * Pre-registered named schemas (from addSchema/OPENAPI_SCHEMA contributions)
   * keep their contributor-chosen name and are always hoisted.
   *
   * @param schema - The schema to resolve
   * @returns The schema or a $ref
   */
  #resolveSchema(schema: unknown): OpenApiSchemaObject {
    // Check if we've seen this schema before (pre-registered or previously hoisted)
    const existingRef = this.#schemaMap.get(schema);
    if (existingRef) {
      return { $ref: `#/components/schemas/${existingRef}` };
    }

    // Check if this is a second use (first reuse)
    if (this.#seenSchemas.has(schema)) {
      // This is a reuse - hoist it with a generated name
      const transformed = this.#transformer.transform(schema);
      const name = this.#hoistSchema(schema, transformed);
      return { $ref: `#/components/schemas/${name}` };
    }

    // First use: transform and mark as seen
    const transformed = this.#transformer.transform(schema);
    this.#seenSchemas.add(schema);

    return transformed;
  }

  /**
   * Hoists a schema to components/schemas with a generated Schema<n> name.
   * Called when a schema is encountered for the second time (first reuse).
   *
   * @param schema - The schema to hoist
   * @param transformed - The already-transformed schema
   * @returns The generated schema name
   */
  #hoistSchema(schema: unknown, transformed: OpenApiSchemaObject): string {
    // Generate a Schema<n> name
    this.#anonymousSchemaCounter++;
    const name = `Schema${this.#anonymousSchemaCounter}`;

    // Store the mapping
    this.#schemaMap.set(schema, name);
    this.#componentSchemas.set(name, transformed);

    return name;
  }
}

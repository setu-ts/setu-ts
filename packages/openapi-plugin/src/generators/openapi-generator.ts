import type {
  RouteInfo,
  RouteSchema,
  RouteValidationMetadata,
  SecurityRequirement,
} from '@setu-ts/common';
import { securityMetadataOf, validationMetadataOf } from '@setu-ts/common';

import type { OpenApiSchemaObject } from '../transformers/zod-to-openapi.ts';
import { ZodToOpenApi } from '../transformers/zod-to-openapi.ts';

/**
 * Plugin names whose routes are operational rather than part of the API being
 * documented, excluded by default through
 * {@linkcode OpenApiGeneratorOptions.excludeOwners}.
 *
 * Owners rather than paths, because every one of these endpoints is
 * CONFIGURABLE — `HealthPlugin({ endpoints })` and `MetricsPlugin({ endpoint })`
 * both accept a path — so a static path list silently stops working the moment
 * an application renames one. `RouteInfo.owner` (M68) reports the plugin whose
 * `register()` created the route and cannot drift.
 */
const DEFAULT_EXCLUDED_OWNERS: readonly string[] = ['health-plugin', 'metrics-plugin'];

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
 * Whether a transformed schema is a shape worth naming as a reusable
 * component: an object, an array, or a composition (`anyOf`/`allOf`) or
 * enumeration of them.
 *
 * A constrained primitive is deliberately excluded — see the call site.
 *
 * @param schema - The transformed schema
 * @returns `true` when the schema earns a `components/schemas` entry
 */
function isStructuralShape(schema: OpenApiSchemaObject): boolean {
  return schema.type === 'object' || schema.type === 'array' ||
    schema.anyOf !== undefined || schema.allOf !== undefined ||
    schema.enum !== undefined;
}

/**
 * Converts an operation-derived name hint (`post-orders-by-idBody`) into a
 * PascalCase component name (`PostOrdersByIdBody`).
 *
 * Splits on every run of characters outside `[A-Za-z0-9]`, upper-cases each
 * part's first character and preserves the rest, so an interior capital in a
 * hand-written hint survives. A hint that sanitizes to nothing falls back to
 * `Schema`, since a component name may not be empty.
 *
 * @param hint - The raw name hint
 * @returns A PascalCase identifier safe as a component name
 */
function toPascalCase(hint: string): string {
  const parts = hint.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const prefixed = joined.replace(/^[0-9]+/, (digits) => `N${digits}`);
  return prefixed || 'Schema';
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
  /**
   * Plugin names whose routes are left out of the generated document,
   * matched against {@linkcode RouteInfo.owner}.
   *
   * Defaults to `['health-plugin', 'metrics-plugin']`, so an application's
   * operational surface (`/health`, `/live`, `/ready`, `/metrics`) does not
   * flow into every client generated from the document. Pass `[]` to document
   * them again.
   *
   * Owners rather than paths, because those endpoints are configurable: a
   * static path list would silently stop excluding a renamed one.
   *
   * @defaultValue `['health-plugin', 'metrics-plugin']`
   */
  readonly excludeOwners?: readonly string[];
  /**
   * Fills each operation's `requestBody` and `parameters` from the validation
   * middleware actually guarding its route, so a route that already carries
   * `validateBody(schema)` does not have to repeat that schema in
   * `schema.body`.
   *
   * A middleware brands itself with `RouteValidationMetadata` (every helper
   * `@setu-ts/validation-plugin` ships does). A value DECLARED on the route's
   * own `schema` always wins, per field.
   *
   * `cookies` brands are read and ignored: `RouteSchema` has no `cookies`
   * field, so there is no declared counterpart, and `@setu-ts/sdk`'s client
   * generator refuses an `in: 'cookie'` parameter outright — emitting one
   * would turn a working document into a codegen failure.
   *
   * Unlike {@linkcode OpenApiGeneratorOptions.deriveSecurity} this is ON by
   * default, because nothing has to be configured for it: a security
   * requirement names a scheme that cannot be inferred from a guard, while the
   * schema on the route IS the schema the document wants.
   *
   * @defaultValue `true`
   */
  readonly deriveRequestSchemas?: boolean;
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
  /** Plugin owners whose routes never reach the document. */
  readonly #excludedOwners: ReadonlySet<string>;
  readonly #schemaMap: Map<unknown, string>;
  readonly #componentSchemas: Map<string, OpenApiSchemaObject>;
  /**
   * Transformer WITHOUT the dedup hook, used where the caller reads the
   * transformed object's own `properties` (parameter destructuring). A `$ref`
   * there would have no `properties` to destructure, so those sites must never
   * be hoisted.
   */
  readonly #plainTransformer: ZodToOpenApi;
  /** How many sites reference each schema identity, filled by the counting pass. */
  readonly #schemaCounts: Map<unknown, number>;
  /** Guards hoisting reentrancy: the node being hoisted must transform normally. */
  readonly #hoisting: Set<unknown>;
  /** `'count'` fills `#schemaCounts`; `'emit'` hoists anything counted twice. */
  #pass: 'count' | 'emit';
  /** Name hint for the schema currently being resolved, e.g. `PostOrdersBody`. */
  #nameHint: string;

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
      ...(options.excludeOwners !== undefined ? { excludeOwners: options.excludeOwners } : {}),
      ...(options.deriveRequestSchemas !== undefined
        ? { deriveRequestSchemas: options.deriveRequestSchemas }
        : {}),
    } as OpenApiGeneratorOptions & {
      title: string;
      version: string;
    };
    this.#excluded = new Set(options.exclude ?? []);
    this.#excludedOwners = new Set(options.excludeOwners ?? DEFAULT_EXCLUDED_OWNERS);
    this.#transformer = new ZodToOpenApi((schema) => this.#hook(schema));
    this.#plainTransformer = new ZodToOpenApi();
    this.#schemaMap = new Map();
    this.#componentSchemas = new Map();
    this.#schemaCounts = new Map();
    this.#hoisting = new Set();
    this.#pass = 'emit';
    this.#nameHint = 'Schema';
  }

  /**
   * Registers a named schema for deduplication.
   *
   * @param name - Schema name
   * @param schema - The schema to register
   */
  addSchema(name: string, schema: unknown): void {
    // Transformed under the reentrancy guard, so the hook does not answer this
    // node with a `$ref` to the component it is in the middle of building.
    this.#hoisting.add(schema);
    const transformed = this.#transformer.transform(schema);
    this.#hoisting.delete(schema);
    this.#schemaMap.set(schema, name);
    this.#componentSchemas.set(name, transformed);
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

    // Pass 1 counts how many sites reference each schema identity, INCLUDING
    // nested ones, because the counting hook is consulted at every node the
    // transformer visits. Pass 2 can then hoist on FIRST use: without the
    // count, the first occurrence has to be inlined and is never rewritten,
    // which is what made one shape appear both inline and as a `$ref`.
    this.#schemaCounts.clear();
    this.#pass = 'count';
    for (const route of routes) {
      if (this.#isExcluded(route)) continue;
      this.#createOperation(route, this.#convertPath(route.path));
    }
    this.#pass = 'emit';

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
      if (this.#isExcluded(route)) continue;

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
    // Generate operationId from method and path
    const operationId = this.#generateOperationId(route.method, openApiPath);

    // Declared schema merged with what the route's validation middleware
    // enforces; declared wins per field.
    const { schema, derived } = this.#effectiveSchema(route);

    // Build parameters from params and query schemas
    const parameters = this.#buildParameters(route, schema);

    // Build request body from body schema
    const requestBody = schema?.body
      ? {
        required: true,
        content: {
          'application/json': {
            schema: this.#resolveSchema(schema.body, `${operationId}Body`),
          },
        },
      }
      : undefined;

    // Build responses from response schema. A route whose request shape was
    // DERIVED also answers 400 when validation fails, so the document says so
    // unless the route declares its own 400 — Redocly flags an operation with
    // no 4XX and is right.
    const responses = this.#buildResponses(schema?.response, operationId);
    if (derived && responses['400'] === undefined) {
      responses['400'] = { description: 'Bad request' };
    }

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
   * Whether a route is left out of the document entirely — by path, or by the
   * plugin that owns it.
   *
   * @param route - The route being considered
   * @returns `true` when the route contributes no operation
   */
  #isExcluded(route: RouteInfo): boolean {
    if (this.#excluded.has(route.path)) return true;
    return route.owner !== undefined && this.#excludedOwners.has(route.owner);
  }

  /**
   * Merges the route's DECLARED schema with what its validation middleware
   * enforces, per field, declared winning.
   *
   * `cookies` brands are read and dropped — see
   * {@linkcode OpenApiGeneratorOptions.deriveRequestSchemas} for why.
   *
   * @param route - The route being documented
   * @returns The effective schema and whether any field came from a brand
   */
  #effectiveSchema(
    route: RouteInfo,
  ): { schema: RouteSchema | undefined; derived: boolean } {
    const declared = route.definition.schema;
    if (this.#options.deriveRequestSchemas === false) {
      return { schema: declared, derived: false };
    }

    const brands: RouteValidationMetadata[] = [];
    for (const middleware of route.definition.middleware ?? []) {
      const metadata = validationMetadataOf(middleware);
      if (metadata !== undefined) brands.push(metadata);
    }
    if (brands.length === 0) return { schema: declared, derived: false };

    const additions: {
      body?: unknown;
      query?: unknown;
      params?: unknown;
      headers?: unknown;
    } = {};
    for (const { target, schema } of brands) {
      // `cookies` deliberately contributes nothing.
      if (target === 'cookies') continue;
      // A route may carry two brands for one target (a merged chain); the
      // FIRST wins, matching the middleware order that actually runs.
      if (declared?.[target] !== undefined) continue;
      if (additions[target] !== undefined) continue;
      additions[target] = schema;
    }

    const keys = Object.keys(additions);
    if (keys.length === 0) return { schema: declared, derived: false };
    return { schema: { ...declared, ...additions }, derived: true };
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
    // `{id}` becomes `by-id` rather than surviving verbatim: OpenAPI puts no
    // character restriction on `operationId`, but braces are URL-unsafe, and a
    // tool that uses the id in an anchor, a filename or a URL — Redocly's
    // recommended ruleset flags exactly this — is entitled to break on them.
    const pathSlug = path
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.replace(/\{([^}]*)\}/g, (_m, name: string) => `by-${name}`))
      .join('-');
    return `${methodLower}-${pathSlug || 'root'}`;
  }

  /**
   * Builds parameters from the route's `params`, `query`, and `headers`
   * schemas, in that order.
   *
   * @param route - Route information
   * @returns Array of parameters
   */
  #buildParameters(
    route: RouteInfo,
    schema: RouteSchema | undefined,
  ): readonly OpenApiParameter[] {
    const parameters: OpenApiParameter[] = [];

    // Extract path parameters from the path template
    const pathParams = this.#extractPathParams(route.path);

    // Hoist transform of params schema to avoid repeated transforms
    let paramsTransformed: Record<string, OpenApiSchemaObject> | undefined;
    if (schema?.params) {
      const paramsObj = this.#plainTransformer.transform(schema.params);
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
      const queryObj = this.#plainTransformer.transform(schema.query);
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
      const headerObj = this.#plainTransformer.transform(schema.headers);
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
    responseSchema: Readonly<Record<number, unknown>> | undefined,
    operationId: string,
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
                  schema: this.#resolveSchema(schema, `${operationId}Response${statusCode}`),
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
  #resolveSchema(schema: unknown, nameHint: string): OpenApiSchemaObject {
    const previous = this.#nameHint;
    this.#nameHint = nameHint;
    try {
      return this.#transformer.transform(schema);
    } finally {
      this.#nameHint = previous;
    }
  }

  /**
   * The per-node hook the deduplicating transformer consults.
   *
   * In the counting pass it records the identity and returns `undefined`, so
   * the transformer walks the whole tree and every NESTED schema is counted
   * exactly as a top-level one is. In the emit pass it answers with a `$ref`
   * for any schema referenced by two or more sites — on FIRST use, which is
   * what stops one shape appearing inline at one site and as a `$ref` at
   * another.
   *
   * @param schema - The node the transformer is about to convert
   * @returns A `$ref`, or `undefined` to transform normally
   */
  #hook(schema: unknown): OpenApiSchemaObject | undefined {
    // The node currently BEING hoisted must transform normally, or it would
    // answer itself with a `$ref` to the component it is building.
    if (this.#hoisting.has(schema)) return undefined;

    if (this.#pass === 'count') {
      const seen = this.#schemaCounts.get(schema) ?? 0;
      this.#schemaCounts.set(schema, seen + 1);
      // Descend only on the FIRST sighting, mirroring the emit pass, where a
      // hoisted schema is transformed once and every later site gets a `$ref`
      // that descends into nothing. Without this the children of a twice-used
      // parent are counted twice as well and hoist into components with a
      // single reference each — and the child claims the name the parent
      // wanted, since both derive it from the same site.
      return seen === 0 ? undefined : {};
    }

    // Pre-registered (addSchema / OPENAPI_SCHEMA) or already hoisted: the
    // contributor-chosen or previously-claimed name wins.
    const existing = this.#schemaMap.get(schema);
    if (existing !== undefined) return { $ref: `#/components/schemas/${existing}` };

    if ((this.#schemaCounts.get(schema) ?? 0) < 2) return undefined;

    this.#hoisting.add(schema);
    const transformed = this.#transformer.transform(schema);
    this.#hoisting.delete(schema);

    // Only a structural shape earns a component. A `$ref` to `{type:'string'}`
    // is larger than the schema it replaces, and `components/schemas` is where
    // a reader looks for MODELS — a reused `z.string().uuid()` hoisted under a
    // name taken from whichever route happened to reach it first is noise.
    if (!isStructuralShape(transformed)) return transformed;

    const name = this.#claimComponentName();
    this.#schemaMap.set(schema, name);
    this.#componentSchemas.set(name, transformed);
    return { $ref: `#/components/schemas/${name}` };
  }

  /**
   * Claims a free component name derived from the site that first hoisted the
   * schema (`PostOrdersResponse409`), suffixing on collision.
   *
   * The old `Schema<n>` was derived from nothing and landed in every generated
   * client as an equally meaningless exported type. A Zod `.describe()` was
   * considered and rejected: a description is prose, so it makes a poor type
   * name.
   *
   * @returns A component name not already in use
   */
  #claimComponentName(): string {
    const base = toPascalCase(this.#nameHint);
    if (!this.#componentSchemas.has(base)) return base;
    for (let n = 2;; n++) {
      const candidate = `${base}${n}`;
      if (!this.#componentSchemas.has(candidate)) return candidate;
    }
  }
}

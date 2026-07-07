/**
 * Metadata storage for the decorator system.
 *
 * Decorators write metadata into a {@linkcode MetadataStore}; the
 * `DecoratorPlugin` reads it during registration and calls the kernel's
 * programmatic APIs. No reflection is used — metadata is stored in plain
 * `Map`s keyed by class reference (ARCHITECTURE.md §12, AI_GUIDELINES §3.3).
 *
 * The store is exposed to other plugins via `CAPABILITIES.METADATA_STORE`
 * (typed as {@linkcode IMetadataStore}); the concrete value shapes
 * (`ControllerMetadata`, `RouteMetadata`, …) are owned by this package.
 *
 * @module
 */
import type { Constructor, IMetadataStore, MiddlewareFunction } from '@hono-enterprise/common';
import type { HttpMethod } from '@hono-enterprise/common';

/**
 * Where a request parameter is sourced from.
 *
 * @since 0.1.0
 */
export type ParameterType = 'body' | 'query' | 'param' | 'header' | 'cookie' | 'custom';

/**
 * Metadata captured by a parameter decorator, later resolved by the
 * {@linkcode resolveParameters} function.
 *
 * @since 0.1.0
 */
export interface ParameterMetadata {
  /** Positional index of the parameter in the handler signature. */
  index: number;
  /** Source of the parameter value. */
  type: ParameterType;
  /** Name for named sources (`@Query('page')`, `@Param('id')`, …). */
  name?: string;
  /** Custom parameter type name (from {@linkcode createParameterDecorator}). */
  customType?: string;
  /** Extra payload captured by a custom parameter decorator. */
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Validation/OpenAPI schema fragments attached to a route.
 *
 * @since 0.1.0
 */
export interface RouteSchemaMetadata {
  /** Request body schema. */
  body?: unknown;
  /** Query parameter schema. */
  query?: unknown;
  /** Path parameter schema. */
  params?: unknown;
}

/**
 * OpenAPI operation metadata attached to a route.
 *
 * @since 0.1.0
 */
export interface OpenApiMetadata {
  /** Operation id. */
  operationId?: string;
  /** Short summary. */
  summary?: string;
  /** Longer description. */
  description?: string;
  /** Responses keyed by status code. */
  responses?: Record<string, unknown>;
  /** Operation tags (method-level). */
  tags?: string[];
}

/**
 * A single HTTP verb + path binding on a handler method.
 *
 * @since 0.1.0
 */
export interface RouteBinding {
  /** HTTP method. */
  readonly method: HttpMethod;
  /** Route path (relative to the controller base path). */
  readonly path: string;
}

/**
 * Metadata captured by class-level decorators (`@Controller`, `@Version`,
 * `@ApiTags`, class-level `@UseGuards`, …), keyed by class.
 *
 * @since 0.1.0
 */
export interface ControllerMetadata {
  /** Base path prefix for all routes in this controller. */
  path: string;
  /** API version prefix (e.g. `'v1'`). */
  version?: string;
  /** Class-level middleware appended to every route. */
  middleware: MiddlewareFunction[];
  /** Class-level guards appended to every route. */
  guards: MiddlewareFunction[];
  /** Class-level interceptors appended to every route. */
  interceptors: MiddlewareFunction[];
  /** Class-level error filters appended to every route. */
  filters: MiddlewareFunction[];
  /** Class-level OpenAPI tags inherited by every route. */
  tags: string[];
  /** Default roles for all routes (overridden by method-level `@Roles`). */
  roles?: string[];
  /** Default permissions for all routes (overridden by method-level `@Permissions`). */
  permissions?: string[];
}

/**
 * Metadata captured by `@Injectable`/`@Inject`, keyed by class.
 *
 * @since 0.1.0
 */
export interface ServiceMetadata {
  /** Lifecycle scope. */
  scope?: 'singleton' | 'scoped' | 'transient';
  /** Capability token to register the service under. */
  token?: string;
  /** Constructor injection tokens, in argument order. */
  inject?: readonly string[];
}

/**
 * Materialized route metadata — one entry per (controller, HTTP verb). Built
 * from a {@linkcode MethodMeta} accumulator's bindings. The
 * `DecoratorPlugin` composes each entry with its controller's class-level
 * metadata before registering the route.
 *
 * @since 0.1.0
 */
export interface RouteMetadata {
  /** HTTP method. */
  readonly method: HttpMethod;
  /** Route path (relative to the controller base path). */
  readonly path: string;
  /** Handler method name on the controller instance. */
  readonly handler: string;
  /** Handler parameters. */
  readonly params: readonly ParameterMetadata[];
  /** Method-level middleware. */
  readonly middleware: readonly MiddlewareFunction[];
  /** Method-level guards. */
  readonly guards: readonly MiddlewareFunction[];
  /** Method-level interceptors. */
  readonly interceptors: readonly MiddlewareFunction[];
  /** Method-level error filters. */
  readonly filters: readonly MiddlewareFunction[];
  /** Validation schemas. */
  readonly schema?: RouteSchemaMetadata;
  /** OpenAPI operation metadata. */
  readonly openapi?: OpenApiMetadata;
  /** Whether the route bypasses auth (`@Public`). */
  readonly isPublic?: boolean;
  /** Required roles (`@Roles`). */
  readonly roles?: readonly string[];
  /** Required permissions (`@Permissions`). */
  readonly permissions?: readonly string[];
}

/**
 * Internal accumulator for a single handler method. Decorators merge into
 * this regardless of TypeScript's decorator application order (parameter and
 * cross-cutting decorators run before the HTTP-verb decorator that adds the
 * binding). {@linkcode MetadataStore.routes} expands each binding into a
 * separate {@linkcode RouteMetadata}.
 *
 * @since 0.1.0
 */
export interface MethodMeta {
  /** Handler method name. */
  readonly handler: string;
  /** HTTP verb + path bindings (one per `@Get`/`@Post`/…). */
  readonly bindings: RouteBinding[];
  /** Handler parameters. */
  readonly params: ParameterMetadata[];
  /** Method-level middleware. */
  readonly middleware: MiddlewareFunction[];
  /** Method-level guards. */
  readonly guards: MiddlewareFunction[];
  /** Method-level interceptors. */
  readonly interceptors: MiddlewareFunction[];
  /** Method-level error filters. */
  readonly filters: MiddlewareFunction[];
  /** Validation schemas. */
  schema?: RouteSchemaMetadata;
  /** OpenAPI operation metadata. */
  openapi?: OpenApiMetadata;
  /** Whether the route bypasses auth (`@Public`). */
  isPublic?: boolean;
  /** Required roles (`@Roles`). */
  roles?: string[];
  /** Required permissions (`@Permissions`). */
  permissions?: string[];
}

/**
 * A custom decorator record captured by {@linkcode createDecorator}, replayed
 * against registered {@linkcode DecoratorHandler}s at registration time.
 *
 * @since 0.1.0
 */
export interface CustomDecoratorRecord {
  /** Decorator name (convention: `plugin-name:decorator`). */
  readonly name: string;
  /** Captured metadata payload. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Decorated class. */
  readonly target: Constructor;
  /** Decorated method name (omitted for class decorators). */
  readonly propertyKey?: string;
}

/** Creates a fresh, empty controller metadata object. */
function emptyController(path: string): ControllerMetadata {
  return { path, middleware: [], guards: [], interceptors: [], filters: [], tags: [] };
}

/** Creates a fresh, empty method metadata accumulator. */
function emptyMethod(handler: string): MethodMeta {
  return {
    handler,
    bindings: [],
    params: [],
    middleware: [],
    guards: [],
    interceptors: [],
    filters: [],
  };
}

/**
 * Concrete {@linkcode IMetadataStore}. Decorators call the `merge*`/`add*`
 * methods; the `DecoratorPlugin` and other consumers read the readonly
 * `controllers`, `services`, and `routes` maps.
 *
 * A single module-level instance ({@linkcode metadataStore}) is shared by all
 * decorators in the process — decorators are applied at class-definition
 * time and have no context to receive a store instance.
 *
 * @since 0.1.0
 */
export class MetadataStore implements IMetadataStore {
  private readonly _controllers = new Map<Constructor, ControllerMetadata>();
  private readonly _services = new Map<Constructor, ServiceMetadata>();
  private readonly _methods = new Map<Constructor, Map<string, MethodMeta>>();
  private readonly _custom: CustomDecoratorRecord[] = [];

  /** Controllers keyed by class. */
  get controllers(): Map<Constructor, Readonly<Record<string, unknown>>> {
    return this._controllers as unknown as Map<Constructor, Readonly<Record<string, unknown>>>;
  }

  /** Services keyed by class. */
  get services(): Map<Constructor, Readonly<Record<string, unknown>>> {
    return this._services as unknown as Map<Constructor, Readonly<Record<string, unknown>>>;
  }

  /**
   * Materialized route metadata, one entry per (controller, HTTP verb).
   * Derived from the internal per-method accumulators so the result is
   * independent of decorator application order.
   */
  get routes(): Map<Constructor, ReadonlyArray<Readonly<Record<string, unknown>>>> {
    const out = new Map<Constructor, ReadonlyArray<Readonly<Record<string, unknown>>>>();
    for (const [target, methods] of this._methods) {
      const list: RouteMetadata[] = [];
      for (const meta of methods.values()) {
        for (const binding of meta.bindings) {
          list.push(this.materializeRoute(meta, binding));
        }
      }
      out.set(target, list as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>);
    }
    return out;
  }

  /**
   * Merges a partial into a class's controller metadata, creating it if
   * absent. Arrays append; scalar fields replace.
   *
   * @param target - The decorated class
   * @param partial - Fields to merge
   */
  mergeController(target: Constructor, partial: Partial<ControllerMetadata>): void {
    const existing = this._controllers.get(target) ?? emptyController(partial.path ?? '');
    const merged: ControllerMetadata = {
      path: partial.path ?? existing.path,
      middleware: [...existing.middleware, ...(partial.middleware ?? [])],
      guards: [...existing.guards, ...(partial.guards ?? [])],
      interceptors: [...existing.interceptors, ...(partial.interceptors ?? [])],
      filters: [...existing.filters, ...(partial.filters ?? [])],
      tags: [...existing.tags, ...(partial.tags ?? [])],
      ...(partial.version !== undefined
        ? { version: partial.version }
        : existing.version !== undefined
        ? { version: existing.version }
        : {}),
      ...(partial.roles !== undefined
        ? { roles: partial.roles }
        : existing.roles !== undefined
        ? { roles: existing.roles }
        : {}),
      ...(partial.permissions !== undefined
        ? { permissions: partial.permissions }
        : existing.permissions !== undefined
        ? { permissions: existing.permissions }
        : {}),
    };
    this._controllers.set(target, merged);
  }

  /**
   * Returns a class's controller metadata, or `undefined`.
   *
   * @param target - The class to look up
   * @returns The metadata, if any
   */
  getController(target: Constructor): ControllerMetadata | undefined {
    return this._controllers.get(target);
  }

  /**
   * Reports whether a class has controller metadata.
   *
   * @param target - The class to look up
   * @returns `true` if decorated with `@Controller`
   */
  hasController(target: Constructor): boolean {
    return this._controllers.has(target);
  }

  /**
   * Merges a partial into a class's service metadata, creating it if absent.
   *
   * @param target - The decorated class
   * @param partial - Fields to merge
   */
  mergeService(target: Constructor, partial: Partial<ServiceMetadata>): void {
    const existing = this._services.get(target) ?? {};
    const merged: ServiceMetadata = { ...existing };
    if (partial.scope !== undefined) {
      merged.scope = partial.scope;
    }
    if (partial.token !== undefined) {
      merged.token = partial.token;
    }
    if (partial.inject !== undefined) {
      merged.inject = partial.inject;
    }
    this._services.set(target, merged);
  }

  /**
   * Returns a class's service metadata, or `undefined`.
   *
   * @param target - The class to look up
   * @returns The metadata, if any
   */
  getService(target: Constructor): ServiceMetadata | undefined {
    return this._services.get(target);
  }

  /**
   * Reports whether a class has service metadata.
   *
   * @param target - The class to look up
   * @returns `true` if decorated with `@Injectable`
   */
  hasService(target: Constructor): boolean {
    return this._services.has(target);
  }

  /**
   * Returns the (mutable) method accumulator for a controller method,
   * creating it if absent.
   *
   * @param target - The controller class
   * @param handler - The method name
   * @returns The method metadata accumulator
   */
  getOrCreateMethod(target: Constructor, handler: string): MethodMeta {
    let methods = this._methods.get(target);
    if (methods === undefined) {
      methods = new Map();
      this._methods.set(target, methods);
    }
    let meta = methods.get(handler);
    if (meta === undefined) {
      meta = emptyMethod(handler);
      methods.set(handler, meta);
    }
    return meta;
  }

  /**
   * Adds an HTTP verb + path binding to a method (`@Get`, `@Post`, …).
   *
   * @param target - The controller class
   * @param handler - The method name
   * @param method - The HTTP method
   * @param path - The route path
   */
  addRouteBinding(
    target: Constructor,
    handler: string,
    method: HttpMethod,
    path: string,
  ): void {
    const meta = this.getOrCreateMethod(target, handler);
    meta.bindings.push({ method, path });
  }

  /**
   * Merges a partial into a method's accumulator. Arrays append; scalar
   * fields replace. Parameter decorators append to `params`.
   *
   * @param target - The controller class
   * @param handler - The method name
   * @param mutate - A function that mutates the accumulator
   */
  mutateMethod(
    target: Constructor,
    handler: string,
    mutate: (meta: MethodMeta) => void,
  ): void {
    const meta = this.getOrCreateMethod(target, handler);
    mutate(meta);
  }

  /**
   * Appends a parameter to a method's accumulator.
   *
   * @param target - The controller class
   * @param handler - The method name
   * @param param - The parameter metadata
   */
  storeParam(target: Constructor, handler: string, param: ParameterMetadata): void {
    this.mutateMethod(target, handler, (meta) => {
      meta.params.push(param);
    });
  }

  /**
   * Returns the method accumulators for a controller.
   *
   * @param target - The controller class
   * @returns Method name → accumulator
   */
  getMethods(target: Constructor): ReadonlyMap<string, MethodMeta> {
    return this._methods.get(target) ?? new Map();
  }

  /**
   * Returns the materialized {@linkcode RouteMetadata} entries for a
   * controller — one per (method, HTTP verb). Unlike the
   * {@linkcode IMetadataStore.routes} getter (loosely typed for external
   * consumers), this returns the concrete shape the plugin composes routes
   * from.
   *
   * @param target - The controller class
   * @returns Materialized route metadata (empty when none)
   */
  getRoutesFor(target: Constructor): RouteMetadata[] {
    const methods = this._methods.get(target);
    if (methods === undefined) {
      return [];
    }
    const list: RouteMetadata[] = [];
    for (const meta of methods.values()) {
      for (const binding of meta.bindings) {
        list.push(this.materializeRoute(meta, binding));
      }
    }
    return list;
  }

  /**
   * Records a custom decorator for replay at registration time.
   *
   * @param record - The custom decorator record
   */
  addCustomDecorator(record: CustomDecoratorRecord): void {
    this._custom.push(record);
  }

  /**
   * Returns all recorded custom decorators.
   *
   * @returns The custom decorator records
   */
  getCustomDecorators(): readonly CustomDecoratorRecord[] {
    return this._custom;
  }

  /**
   * Removes all stored metadata. Intended for test isolation — decorators
   * applied at module-evaluation time are NOT re-run, so callers that rely on
   * decorated fixtures should not clear between tests using those fixtures.
   */
  clear(): void {
    this._controllers.clear();
    this._services.clear();
    this._methods.clear();
    this._custom.length = 0;
  }

  /**
   * Builds a single materialized {@linkcode RouteMetadata} from a method
   * accumulator and one of its bindings.
   */
  private materializeRoute(meta: MethodMeta, binding: RouteBinding): RouteMetadata {
    return {
      method: binding.method,
      path: binding.path,
      handler: meta.handler,
      params: [...meta.params],
      middleware: [...meta.middleware],
      guards: [...meta.guards],
      interceptors: [...meta.interceptors],
      filters: [...meta.filters],
      ...(meta.schema !== undefined ? { schema: meta.schema } : {}),
      ...(meta.openapi !== undefined ? { openapi: meta.openapi } : {}),
      ...(meta.isPublic ? { isPublic: true } : {}),
      ...(meta.roles !== undefined ? { roles: [...meta.roles] } : {}),
      ...(meta.permissions !== undefined ? { permissions: [...meta.permissions] } : {}),
    };
  }
}

/**
 * The process-wide singleton decorators write to. The `DecoratorPlugin`
 * registers this same instance under `CAPABILITIES.METADATA_STORE` so
 * `ctx.metadata` resolves to it.
 *
 * @since 0.1.0
 */
export const metadataStore = new MetadataStore();

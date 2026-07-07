/**
 * DecoratorPlugin — reads decorator-captured metadata and registers routes,
 * services, and middleware with the kernel's programmatic APIs.
 *
 * Decorators are inert without this plugin: they write to the shared
 * {@linkcode metadataStore} at class-definition time, but only this plugin's
 * `register()` reads that store and calls `ctx.router` / `ctx.services` /
 * `ctx.middleware`. It also registers the store under
 * `CAPABILITIES.METADATA_STORE` so `ctx.metadata` resolves to it.
 *
 * @module
 */
import type {
  ClassProvider,
  Constructor,
  DecoratorHandler,
  HttpMethod,
  IPlugin,
  IPluginContext,
  MiddlewareFunction,
  ProviderOptions,
  RouteDefinition,
  RouteHandler,
  RouteSchema,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import type {
  ControllerMetadata,
  ParameterMetadata,
  RouteMetadata,
  ServiceMetadata,
} from '../metadata/metadata-store.ts';
import { discoverControllers } from '../discovery/controller-discovery.ts';
import { resolveParameters } from '../resolvers/parameter-resolver.ts';
import { className, isHandlerResult, joinPaths } from '../internal.ts';

/**
 * Options for {@linkcode DecoratorPlugin}.
 *
 * @since 0.1.0
 */
export interface DecoratorPluginOptions {
  /**
   * When `true`, auto-scan `controllersPath` for decorated classes. Discovery
   * failures are logged as warnings and never crash the application.
   */
  readonly autoDiscover?: boolean;
  /** Glob path for controller discovery (used when `autoDiscover` is `true`). */
  readonly controllersPath?: string;
  /** Explicit list of controller classes to register. */
  readonly controllers?: readonly Constructor[];
  /** Explicit list of service classes to register. */
  readonly services?: readonly Constructor[];
}

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'decorator-plugin';

/** Removes duplicate class references, preserving order. */
function dedup(classes: readonly Constructor[]): Constructor[] {
  const seen = new Set<Constructor>();
  const out: Constructor[] = [];
  for (const c of classes) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** Default capability token for a service without an explicit `@Injectable` token. */
function serviceToken(meta: ServiceMetadata | undefined, target: Constructor): string {
  return meta?.token ?? className(target);
}

/**
 * Registers a class in the DI container (when present) under its token, with
 * its inject tokens and scope. No-op if the container is absent or the token
 * is already registered.
 */
function registerInContainer(
  ctx: IPluginContext,
  target: Constructor,
  meta: ServiceMetadata | undefined,
): void {
  const container = ctx.container;
  if (container === undefined) {
    return;
  }
  const token = serviceToken(meta, target);
  if (container.has(token)) {
    return;
  }
  const provider: ClassProvider<unknown> = {
    useClass: target,
    ...(meta?.inject !== undefined ? { inject: meta.inject } : {}),
  };
  const opts: ProviderOptions | undefined = meta?.scope !== undefined
    ? { scope: meta.scope }
    : undefined;
  container.register<unknown>(token, provider, opts);
}

/**
 * Instantiates a class. Prefers the DI container (when the class is
 * registered), falls back to constructor injection resolved from the service
 * registry, then to a no-argument constructor.
 */
function instantiate(target: Constructor, ctx: IPluginContext): unknown {
  const meta = metadataStore.getService(target);
  const container = ctx.container;
  if (container !== undefined && meta !== undefined) {
    const token = serviceToken(meta, target);
    if (container.has(token)) {
      return container.resolve<unknown>(token);
    }
  }
  if (meta?.inject !== undefined && meta.inject.length > 0) {
    const deps = meta.inject.map((t) => ctx.services.get<object>(t));
    return new (target as new (...args: unknown[]) => unknown)(...deps);
  }
  return new (target as new () => unknown)();
}

/**
 * Registers a service class — with the DI container when present, otherwise
 * instantiated directly and registered in the service registry.
 */
function registerService(ctx: IPluginContext, target: Constructor): void {
  const meta = metadataStore.getService(target);
  const token = serviceToken(meta, target);
  if (ctx.container !== undefined) {
    registerInContainer(ctx, target, meta);
    return;
  }
  if (ctx.services.has(token)) {
    return;
  }
  const instance = instantiate(target, ctx);
  ctx.services.register<object>(token, instance as object);
}

/**
 * Builds the route handler wrapper: resolves decorator parameters, calls the
 * controller method, and serializes the return value (unless the method
 * already returned a `HandlerResult`).
 */
function createHandler(
  instance: unknown,
  handlerName: string,
  params: readonly ParameterMetadata[],
): RouteHandler {
  const fn = (instance as Record<string, unknown>)[handlerName];
  if (typeof fn !== 'function') {
    throw new Error(`Handler '${handlerName}' is not a method on the controller instance.`);
  }
  const method = fn.bind(instance) as (...args: unknown[]) => unknown | Promise<unknown>;
  return async (ctx) => {
    const args = await resolveParameters(ctx, params);
    const result = await method(...args);
    if (isHandlerResult(result)) {
      return result;
    }
    return ctx.response.json(result);
  };
}

/** Composes the ordered middleware chain for a route (class then method). */
function composeMiddleware(
  ctrl: ControllerMetadata,
  route: RouteMetadata,
): MiddlewareFunction[] {
  return [
    ...ctrl.guards,
    ...route.guards,
    ...ctrl.interceptors,
    ...route.interceptors,
    ...ctrl.middleware,
    ...route.middleware,
    ...ctrl.filters,
    ...route.filters,
  ];
}

/** Builds the response-schema map from `@ApiResponse` metadata, if any. */
function buildResponseSchemas(route: RouteMetadata): Record<number, unknown> | undefined {
  const responses = route.openapi?.responses;
  if (responses === undefined) {
    return undefined;
  }
  const out: Record<number, unknown> = {};
  for (const [status, value] of Object.entries(responses)) {
    const code = Number(status);
    if (!Number.isNaN(code)) {
      out[code] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Builds the {@linkcode RouteSchema} from validation and OpenAPI metadata.
 * Returns `undefined` when no schema-relevant metadata is present.
 */
function buildRouteSchema(
  ctrl: ControllerMetadata,
  route: RouteMetadata,
): RouteSchema | undefined {
  const schema = route.schema;
  const tags = [...ctrl.tags, ...(route.openapi?.tags ?? [])];
  const summary = route.openapi?.summary;
  const response = buildResponseSchemas(route);
  const hasSchema = schema !== undefined;
  const hasTags = tags.length > 0;
  if (!hasSchema && !hasTags && summary === undefined && response === undefined) {
    return undefined;
  }
  return {
    ...(schema?.body !== undefined ? { body: schema.body } : {}),
    ...(schema?.query !== undefined ? { query: schema.query } : {}),
    ...(schema?.params !== undefined ? { params: schema.params } : {}),
    ...(hasTags ? { tags } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(response !== undefined ? { response } : {}),
  };
}

/** Registers a single route on the router for the given HTTP method. */
function registerOnRouter(
  ctx: IPluginContext,
  method: HttpMethod,
  path: string,
  routeDef: RouteDefinition,
): void {
  switch (method) {
    case 'GET':
      ctx.router.get(path, routeDef);
      return;
    case 'POST':
      ctx.router.post(path, routeDef);
      return;
    case 'PUT':
      ctx.router.put(path, routeDef);
      return;
    case 'PATCH':
      ctx.router.patch(path, routeDef);
      return;
    case 'DELETE':
      ctx.router.delete(path, routeDef);
      return;
    case 'HEAD':
      ctx.router.head(path, routeDef);
      return;
    case 'OPTIONS':
      ctx.router.options(path, routeDef);
      return;
  }
}

/**
 * Registers all routes for a controller: instantiates it, then for each
 * route metadata entry builds a {@linkcode RouteDefinition} (merging class-
 * and method-level middleware/schema) and registers it on the router.
 */
function registerController(ctx: IPluginContext, target: Constructor): void {
  const ctrlMeta = metadataStore.getController(target);
  if (ctrlMeta === undefined) {
    return;
  }
  registerInContainer(ctx, target, metadataStore.getService(target));
  const instance = instantiate(target, ctx);
  for (const route of metadataStore.getRoutesFor(target)) {
    const fullPath = joinPaths(ctrlMeta.version ?? '', ctrlMeta.path, route.path);
    const handler = createHandler(instance, route.handler, route.params);
    const middleware = composeMiddleware(ctrlMeta, route);
    const schema = buildRouteSchema(ctrlMeta, route);
    const routeDef: RouteDefinition = {
      handler,
      ...(middleware.length > 0 ? { middleware } : {}),
      ...(schema !== undefined ? { schema } : {}),
    };
    registerOnRouter(ctx, route.method, fullPath, routeDef);
  }
}

/** Replays custom decorator records against registered `DecoratorHandler`s. */
function replayCustomDecorators(ctx: IPluginContext): void {
  if (!ctx.services.has(CAPABILITIES.DECORATOR_HANDLER)) {
    return;
  }
  const handlers = ctx.services.getAll<{ name: string; handler: DecoratorHandler }>(
    CAPABILITIES.DECORATOR_HANDLER,
  );
  const byName = new Map<string, DecoratorHandler[]>();
  for (const h of handlers) {
    const list = byName.get(h.name) ?? [];
    list.push(h.handler);
    byName.set(h.name, list);
  }
  for (const record of metadataStore.getCustomDecorators()) {
    const list = byName.get(record.name);
    if (list === undefined) {
      continue;
    }
    for (const handler of list) {
      if (record.propertyKey !== undefined) {
        handler(record.metadata, record.target, record.propertyKey);
      } else {
        handler(record.metadata, record.target);
      }
    }
  }
}

/**
 * Creates the DecoratorPlugin.
 *
 * The plugin registers the shared {@linkcode metadataStore} under
 * `CAPABILITIES.METADATA_STORE` (so `ctx.metadata` resolves to it), then
 * registers routes and services from the explicit lists and/or auto-discovered
 * classes, and replays custom decorators against any registered
 * `DecoratorHandler`s.
 *
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @example
 * ```typescript
 * import { DecoratorPlugin } from '@hono-enterprise/decorator-plugin';
 *
 * app.register(DecoratorPlugin({
 *   controllers: [UserController, OrderController],
 * }));
 * ```
 * @since 0.1.0
 */
export function DecoratorPlugin(options?: DecoratorPluginOptions): IPlugin {
  const opts = options ?? {};
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    provides: [CAPABILITIES.METADATA_STORE],
    priority: PLUGIN_PRIORITY.LOW,

    async register(ctx: IPluginContext): Promise<void> {
      if (!ctx.services.has(CAPABILITIES.METADATA_STORE)) {
        ctx.services.register(CAPABILITIES.METADATA_STORE, metadataStore);
      }

      let discoveredControllers: Constructor[] = [];
      let discoveredServices: Constructor[] = [];
      if (opts.autoDiscover === true && opts.controllersPath !== undefined) {
        const result = await discoverControllers(
          { path: opts.controllersPath },
          ctx.runtime,
          metadataStore,
        );
        discoveredControllers = [...result.controllers];
        discoveredServices = [...result.services];
        if (result.errors.length > 0 && ctx.logger !== undefined) {
          for (const e of result.errors) {
            ctx.logger.warn('Decorator discovery error', { file: e.file, error: e.error });
          }
        }
      }

      const controllers = dedup([...(opts.controllers ?? []), ...discoveredControllers]);
      const services = dedup([...(opts.services ?? []), ...discoveredServices]);

      for (const svc of services) {
        registerService(ctx, svc);
      }
      for (const ctrl of controllers) {
        registerController(ctx, ctrl);
      }
      replayCustomDecorators(ctx);
    },
  };
}

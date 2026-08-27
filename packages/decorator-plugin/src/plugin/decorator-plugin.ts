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
  FactoryProvider,
  HttpMethod,
  IPlugin,
  IPluginContext,
  IValidationService,
  MiddlewareFunction,
  ProviderOptions,
  RouteDefinition,
  RouteHandler,
  RouteSchema,
  ValidationTarget,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import type {
  ControllerMetadata,
  ParameterMetadata,
  RouteMetadata,
  ServiceMetadata,
} from '../metadata/metadata-store.ts';
import { discoverControllers } from '../discovery/controller-discovery.ts';
import { findUnresolvableParameters, resolveParameters } from '../resolvers/parameter-resolver.ts';
import { className, isHandlerResult, joinPaths } from '../internal.ts';
import denoJson from '../../deno.json' with { type: 'json' };

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
  /**
   * When `true` (the default), a route decorated with `@ValidateBody` /
   * `@ValidateQuery` / `@ValidateParams` gets the registered validation
   * capability's enforcing middleware appended LAST in its chain (innermost,
   * after guards and filters), so an invalid request is rejected with `400`
   * before the handler runs — while guard `401`/`403` precedence is preserved.
   *
   * When `false`, schemas stay description-only (surfaced via
   * `RouteDefinition.schema` for OpenAPI) and no enforcement middleware is
   * appended; the absent-capability warning is also silenced.
   */
  readonly enforceSchemas?: boolean;
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
 * Resolves which constructor arguments a class marked optional, validating that
 * each one names an argument the `@Inject` list actually covers.
 *
 * `@Inject(a, Optional(b))` cannot produce an out-of-range index — the marker
 * sits in the position of the argument it describes — but `mergeCtorOptional`
 * is public store API, so a direct caller can, and an index past the end would
 * otherwise pass `undefined` for an argument no token names.
 *
 * @throws {Error} When an optional index names no injected argument.
 */
function effectiveOptional(
  target: Constructor,
  inject: readonly string[] | undefined,
): ReadonlySet<number> {
  const optional = metadataStore.ctorOptional(target);
  for (const index of optional) {
    if (inject === undefined || inject[index] === undefined) {
      throw new Error(
        `${className(target)} marks constructor parameter ${index} optional, but the ` +
          `@Inject(...) list names no token for it. Optional marks an injected dependency as ` +
          `absent-tolerant; it does not name one — type-inferred injection needs ` +
          `emitDecoratorMetadata, which Deno does not support.`,
      );
    }
  }
  return optional;
}

/**
 * Resolves constructor arguments from a token list, passing `undefined` for an
 * `@Optional` argument whose token has no provider.
 *
 * `has` is a faithful predicate for `get`/`resolve` on both sources: the
 * container's consults its parent chain and the auto-register external resolver
 * under the same conditions resolution does, and the registry's reports the same
 * map it reads from. A present token is therefore resolved directly, so an error
 * raised while BUILDING it propagates instead of being masked as absence.
 */
function resolveDeps(
  inject: readonly string[],
  optional: ReadonlySet<number>,
  has: (token: string) => boolean,
  read: (token: string) => unknown,
): unknown[] {
  return inject.map((token, index) => {
    if (optional.has(index) && !has(token)) {
      return undefined;
    }
    return read(token);
  });
}

/**
 * Registers a class in the DI container (when present) under its token, with
 * its inject tokens and scope. No-op if the container is absent or the token
 * is already registered.
 *
 * A class with no `@Optional` argument registers as a {@linkcode ClassProvider},
 * so the container resolves each token itself — unchanged behaviour, and the
 * dependencies stay affine to the container the resolution happens on.
 *
 * A class WITH an `@Optional` argument cannot use that form, because
 * `ClassProvider.inject` is a bare token list with nowhere to record
 * optionality. It registers a lazy `useFactory` instead, which resolves its own
 * arguments and so can skip an absent one. `FactoryProvider.useFactory` takes no
 * arguments, so that factory closes over the container the class was registered
 * on: the class's own scope is still honored by the container (the provider
 * entry carries it), but its dependencies resolve from the registering
 * container rather than the resolving scope.
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
  const inject = meta?.inject;
  const optional = effectiveOptional(target, inject);
  const opts: ProviderOptions | undefined = meta?.scope !== undefined
    ? { scope: meta.scope }
    : undefined;
  if (optional.size > 0 && inject !== undefined) {
    const factory: FactoryProvider<unknown> = {
      useFactory: (): unknown =>
        new (target as new (...args: unknown[]) => unknown)(
          ...resolveDeps(
            inject,
            optional,
            (t) => container.has(t),
            (t) => container.resolve<unknown>(t),
          ),
        ),
    };
    container.register<unknown>(token, factory, opts);
    return;
  }
  const provider: ClassProvider<unknown> = {
    useClass: target,
    ...(inject !== undefined ? { inject } : {}),
  };
  container.register<unknown>(token, provider, opts);
}

/**
 * Instantiates a class. Prefers the DI container (when the class is
 * registered), falls back to constructor injection resolved from the service
 * registry, then to a no-argument constructor.
 *
 * The container lookup deliberately does NOT require service metadata. A
 * `@Controller` carries no `@Injectable`, so requiring it sent every
 * constructor-injected controller down the registry path even in a DI
 * application — where its dependencies live in the container, not the registry,
 * so construction failed outright. `serviceToken` already defaults to the class
 * name, which is the token `registerInContainer` registered it under.
 */
function instantiate(target: Constructor, ctx: IPluginContext): unknown {
  const meta = metadataStore.getService(target);
  const container = ctx.container;
  if (container !== undefined) {
    const token = serviceToken(meta, target);
    if (container.has(token)) {
      return container.resolve<unknown>(token);
    }
  }
  const inject = meta?.inject;
  if (inject !== undefined && inject.length > 0) {
    const optional = effectiveOptional(target, inject);
    const deps = resolveDeps(
      inject,
      optional,
      (t) => ctx.services.has(t),
      (t) => ctx.services.get<object>(t),
    );
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
 *
 * `@Public` is carried through as an empty `security` array, the OpenAPI
 * marker for a public operation. Without it a decorated route has no way to
 * opt out of a document-level security requirement, and a route explicitly
 * marked public would be documented as requiring the very token it bypasses.
 * `@Roles`/`@Permissions` are deliberately NOT mapped: a role is not a
 * security scheme, and there is no way to infer which declared scheme grants
 * it without inventing a name the document does not contain.
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
  const isPublic = route.isPublic === true;
  if (
    !hasSchema && !hasTags && summary === undefined && response === undefined && !isPublic
  ) {
    return undefined;
  }
  return {
    ...(schema?.body !== undefined ? { body: schema.body } : {}),
    ...(schema?.query !== undefined ? { query: schema.query } : {}),
    ...(schema?.params !== undefined ? { params: schema.params } : {}),
    ...(hasTags ? { tags } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(isPublic ? { security: [] } : {}),
  };
}

/**
 * The validation targets a `@ValidateXxx` decorator can produce, in schema
 * order. `RouteSchema` has no `cookies` key, so headers/cookies are never
 * decorator-enforced.
 */
const DECORATOR_SCHEMA_TARGETS = ['body', 'query', 'params'] as const;

/** A present schema target with the schema attached to it. */
interface SchemaTarget {
  readonly target: ValidationTarget;
  readonly schema: unknown;
}

/**
 * Returns the validation targets present on a route's schema, in schema
 * order. Empty when the route carries no validation schema at all.
 */
function enforcedTargets(route: RouteMetadata): SchemaTarget[] {
  const schema = route.schema;
  if (schema === undefined) {
    return [];
  }
  const out: SchemaTarget[] = [];
  for (const target of DECORATOR_SCHEMA_TARGETS) {
    const s = schema[target];
    if (s !== undefined) {
      out.push({ target, schema: s });
    }
  }
  return out;
}

/**
 * Warns that a route carries validation schemas but no
 * `CAPABILITIES.VALIDATION` provider is registered, so the schemas stay
 * description-only and are NOT enforced. One warning per affected route.
 *
 * Warns rather than throws, following M64's precedent: the decorators shipped
 * as inert in M9, an application may legitimately want only the OpenAPI
 * description, and turning a released no-op into a startup crash on upgrade is
 * a worse failure than a named warning.
 */
function warnUnenforcedSchemas(
  ctx: IPluginContext,
  controller: Constructor,
  route: RouteMetadata,
  targets: readonly SchemaTarget[],
): void {
  if (ctx.logger === undefined) {
    return;
  }
  ctx.logger.warn(
    'Route declares validation schemas but no validation capability is registered; they are description-only and NOT enforced',
    {
      controller: className(controller),
      handler: route.handler,
      targets: targets.map((t) => t.target),
      hint: 'Register ValidationPlugin (or another CAPABILITIES.VALIDATION provider) to enforce ' +
        'them, or set enforceSchemas: false on DecoratorPlugin to silence this warning.',
    },
  );
}

/**
 * Appends the validation capability's enforcing middleware for each present
 * schema target, LAST in the route's middleware array (innermost — after
 * guards, interceptors and filters), so guard `401`/`403` decisions still
 * precede any `400`. No-op when enforcement is off or the route has no
 * validation schema.
 */
function appendValidationMiddleware(
  ctx: IPluginContext,
  controller: Constructor,
  route: RouteMetadata,
  middleware: MiddlewareFunction[],
  validation: IValidationService | undefined,
): void {
  const targets = enforcedTargets(route);
  if (targets.length === 0) {
    return;
  }
  if (validation === undefined) {
    warnUnenforcedSchemas(ctx, controller, route, targets);
    return;
  }
  for (const { target, schema } of targets) {
    middleware.push(validation.middleware(schema, target));
  }
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
 * Warns about a class passed explicitly in `controllers` that carries no
 * `@Controller` metadata, because `registerController` skips it silently and
 * every one of its routes then answers 404 with nothing logged.
 *
 * The likeliest cause is two copies of this package in one process: decorators
 * write to the `metadataStore` of the copy the application imported, while this
 * plugin reads its own copy's store and finds it empty. The other cause is a
 * missing `@Controller`. Only the explicit list is checked — auto-discovery
 * filters to decorated classes already, so a discovered class is never a
 * developer mistake.
 */
function warnControllersWithoutMetadata(
  ctx: IPluginContext,
  controllers: readonly Constructor[],
): void {
  if (ctx.logger === undefined) {
    return;
  }
  for (const target of controllers) {
    if (!metadataStore.hasController(target)) {
      ctx.logger.warn(
        'Controller has no @Controller metadata and registers no routes',
        {
          controller: className(target),
          hint:
            'Add @Controller(), or check that the application and DecoratorPlugin resolve to the ' +
            'same @setu-ts/decorator-plugin copy — decorators write to the metadata store of the ' +
            'copy that defines them.',
        },
      );
    }
  }
}

/**
 * Warns about custom parameters that no resolver can satisfy, which would
 * otherwise reach the handler as `undefined` and fail on first use with no
 * indication of the cause.
 *
 * Warns rather than throws: `resolveParameter` has always returned `undefined`
 * for an unregistered custom type, and an application may legitimately register
 * its resolvers after the plugin registers, in which case this reading is
 * stale. A warning names the problem without breaking that arrangement.
 */
function warnUnresolvableParameters(
  ctx: IPluginContext,
  target: Constructor,
  route: RouteMetadata,
): void {
  if (ctx.logger === undefined) {
    return;
  }
  for (const param of findUnresolvableParameters(route.params)) {
    ctx.logger.warn(
      'Decorated parameter cannot be resolved and will be undefined',
      {
        controller: className(target),
        handler: route.handler,
        parameterIndex: param.index,
        customType: param.customType ?? '(none)',
        hint:
          'Register a resolver with registerParameterResolver(), or — for @Ctx() — check that ' +
          'the application and DecoratorPlugin resolve to the same @setu-ts/decorator-plugin version.',
      },
    );
  }
}

/**
 * Registers all routes for a controller: instantiates it, then for each
 * route metadata entry builds a {@linkcode RouteDefinition} (merging class-
 * and method-level middleware/schema) and registers it on the router.
 */
function registerController(
  ctx: IPluginContext,
  target: Constructor,
  validation: IValidationService | undefined,
  enforceSchemas: boolean,
): void {
  const ctrlMeta = metadataStore.getController(target);
  if (ctrlMeta === undefined) {
    return;
  }
  registerInContainer(ctx, target, metadataStore.getService(target));
  const instance = instantiate(target, ctx);
  for (const route of metadataStore.getRoutesFor(target)) {
    const fullPath = joinPaths(ctrlMeta.version ?? '', ctrlMeta.path, route.path);
    warnUnresolvableParameters(ctx, target, route);
    const handler = createHandler(instance, route.handler, route.params);
    const middleware = composeMiddleware(ctrlMeta, route);
    if (enforceSchemas) {
      appendValidationMiddleware(ctx, target, route, middleware, validation);
    }
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
 * import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
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
    version: denoJson.version,
    provides: [CAPABILITIES.METADATA_STORE],
    // A real dependency edge (not priority luck): a REPLACEMENT validation
    // provider registered at a higher priority number then still lands before
    // this plugin, so register-time resolution sees it.
    optionalDependencies: [CAPABILITIES.VALIDATION],
    priority: PLUGIN_PRIORITY.LOW,

    async register(ctx: IPluginContext): Promise<void> {
      if (!ctx.services.has(CAPABILITIES.METADATA_STORE)) {
        ctx.services.register(CAPABILITIES.METADATA_STORE, metadataStore);
      }

      // Resolved ONCE per application start, not per request: the provider is
      // fixed at registration time (optionalDependencies guarantees a
      // replacement provider has already registered).
      const enforceSchemas = opts.enforceSchemas ?? true;
      const validation = ctx.services.has(CAPABILITIES.VALIDATION)
        ? ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION)
        : undefined;

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

      warnControllersWithoutMetadata(ctx, opts.controllers ?? []);

      const controllers = dedup([...(opts.controllers ?? []), ...discoveredControllers]);
      const services = dedup([...(opts.services ?? []), ...discoveredServices]);

      for (const svc of services) {
        registerService(ctx, svc);
      }
      for (const ctrl of controllers) {
        registerController(ctx, ctrl, validation, enforceSchemas);
      }
      replayCustomDecorators(ctx);
    },
  };
}

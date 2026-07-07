/**
 * Fake {@linkcode IPluginContext} with observable internals for
 * decorator-plugin integration tests.
 *
 * The service registry is multi-aware (so `CAPABILITIES.DECORATOR_HANDLER`
 * contributions can be retrieved with `getAll`), the router records every
 * registered route, and the lifecycle API records every hook.
 *
 * @module
 */
import type {
  DecoratorHandler,
  IApplication,
  IContainer,
  ILogger,
  IPluginContext,
  IRouterApi,
  IRuntimeServices,
  IServiceRegistry,
  MiddlewareFunction,
  MiddlewareOptions,
  RouteDefinition,
  RouteHandler,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { createFakeRuntime } from './fake-runtime.ts';
import { createFakeLifecycle } from './fake-lifecycle.ts';
import type { LifecycleHook } from './fake-lifecycle.ts';

/** A route recorded by the fake router. */
export interface RegisteredRoute {
  /** HTTP method. */
  readonly method: string;
  /** Route path. */
  readonly path: string;
  /** The handler or route definition passed to the router. */
  readonly route: RouteHandler | RouteDefinition;
}

/** Options for {@linkcode createFakeContext}. */
export interface FakeContextOptions {
  /** DI container (optional; absent by default). */
  readonly container?: IContainer;
  /** Logger (optional). */
  readonly logger?: ILogger;
  /** Runtime services (defaults to a fresh fake runtime). */
  readonly runtime?: IRuntimeServices;
}

/** A recorded middleware entry. */
export interface MiddlewareEntry {
  readonly fn: MiddlewareFunction;
  readonly options?: MiddlewareOptions;
}

/**
 * Creates a fake plugin context with observable internals.
 *
 * @param options - Optional container, logger, runtime
 * @returns The context plus observable maps/arrays for assertions
 */
export function createFakeContext(options: FakeContextOptions = {}): {
  readonly ctx: IPluginContext;
  readonly services: Map<string, unknown[]>;
  readonly middleware: MiddlewareEntry[];
  readonly routes: RegisteredRoute[];
  readonly decoratorHandlers: { readonly name: string; readonly handler: DecoratorHandler }[];
  readonly lifecycleHooks: LifecycleHook[];
} {
  const services = new Map<string, unknown[]>();
  const middleware: MiddlewareEntry[] = [];
  const routes: RegisteredRoute[] = [];
  const decoratorHandlers: { name: string; handler: DecoratorHandler }[] = [];
  const { api: lifecycle, hooks: lifecycleHooks } = createFakeLifecycle();
  const runtime = options.runtime ?? createFakeRuntime();

  const serviceRegistry: IServiceRegistry = {
    register<T extends object>(token: string, service: T): void {
      const arr = services.get(token) ?? [];
      arr.push(service);
      services.set(token, arr);
    },
    registerFactory<T extends object>(token: string, factory: () => T): void {
      const arr = services.get(token) ?? [];
      arr.push(factory());
      services.set(token, arr);
    },
    get<T extends object>(token: string): T {
      const arr = services.get(token);
      if (arr === undefined || arr.length === 0) {
        throw new Error(`Service '${token}' not registered`);
      }
      return arr[arr.length - 1] as T;
    },
    getAll<T extends object>(token: string): readonly T[] {
      return (services.get(token) ?? []) as T[];
    },
    has(token: string): boolean {
      const arr = services.get(token);
      return arr !== undefined && arr.length > 0;
    },
    unregister(token: string): boolean {
      return services.delete(token);
    },
  };

  const router: IRouterApi = {
    get(path, route) {
      routes.push({ method: 'GET', path, route });
    },
    post(path, route) {
      routes.push({ method: 'POST', path, route });
    },
    put(path, route) {
      routes.push({ method: 'PUT', path, route });
    },
    patch(path, route) {
      routes.push({ method: 'PATCH', path, route });
    },
    delete(path, route) {
      routes.push({ method: 'DELETE', path, route });
    },
    head(path, route) {
      routes.push({ method: 'HEAD', path, route });
    },
    options(path, route) {
      routes.push({ method: 'OPTIONS', path, route });
    },
    group(_prefix, configure) {
      configure(router);
    },
  };

  const decoratorsApi = {
    register(name: string, handler: DecoratorHandler): void {
      decoratorHandlers.push({ name, handler });
      serviceRegistry.register(CAPABILITIES.DECORATOR_HANDLER, { name, handler });
    },
  };

  const ctx: IPluginContext = {
    runtime,
    services: serviceRegistry,
    middleware: {
      add(fn: MiddlewareFunction, opts?: MiddlewareOptions): void {
        const entry: MiddlewareEntry = opts !== undefined ? { fn, options: opts } : { fn };
        middleware.push(entry);
      },
    },
    router,
    lifecycle,
    health: { register() {} },
    metrics: { register() {} },
    openapi: { addSchema() {} },
    decorators: decoratorsApi,
    cli: { register() {} },
    environment: { validate() {} },
    ...(options.container !== undefined ? { container: options.container } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    options: {},
    app: {} as unknown as IApplication,
  };

  return { ctx, services, middleware, routes, decoratorHandlers, lifecycleHooks };
}

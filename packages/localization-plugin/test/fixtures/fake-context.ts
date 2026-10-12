/**
 * Fake `IPluginContext` capturing what `LocalizationPlugin.register()` does:
 * service registrations, middleware, routes and health indicators.
 *
 * @module
 */
import type {
  HealthCheckResult,
  ILogger,
  IPluginContext,
  MiddlewareFunction,
  MiddlewareOptions,
  RouteDefinition,
  RouteHandler,
} from '@setu-ts/common';

/** One captured log line. */
export interface LogLine {
  readonly level: string;
  readonly message: string;
}

/** The fake and its capture buffers. */
export interface FakeContext {
  readonly ctx: IPluginContext;
  readonly services: Map<string, unknown>;
  readonly middleware: { fn: MiddlewareFunction; options: MiddlewareOptions | undefined }[];
  readonly routes: Map<string, RouteHandler | RouteDefinition>;
  readonly health: Map<string, () => Promise<HealthCheckResult>>;
  readonly logs: LogLine[];
}

/**
 * Creates the fake.
 *
 * @param withLogger - Expose a capturing logger on `ctx.logger`
 * @returns The fake context and its buffers
 */
export function createFakeContext(withLogger = true): FakeContext {
  const services = new Map<string, unknown>();
  const middleware: FakeContext['middleware'] = [];
  const routes = new Map<string, RouteHandler | RouteDefinition>();
  const health = new Map<string, () => Promise<HealthCheckResult>>();
  const logs: LogLine[] = [];
  const log = (level: string) => (message: string) => {
    logs.push({ level, message });
  };
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  } as unknown as ILogger;
  const ctx = {
    services: {
      has: (token: string) => services.has(token),
      get: <T>(token: string) => services.get(token) as T,
      getAll: () => [],
      register: (token: string, service: unknown) => {
        services.set(token, service);
      },
      registerFactory: () => {},
      unregister: () => false,
    },
    middleware: {
      add: (fn: MiddlewareFunction, options?: MiddlewareOptions) => {
        middleware.push({ fn, options });
      },
    },
    router: {
      get: (path: string, route: RouteHandler | RouteDefinition) => {
        routes.set(path, route);
      },
    },
    health: {
      register: (name: string, indicator: () => Promise<HealthCheckResult>) => {
        health.set(name, indicator);
      },
    },
    ...(withLogger ? { logger } : {}),
  } as unknown as IPluginContext;
  return { ctx, services, middleware, routes, health, logs };
}

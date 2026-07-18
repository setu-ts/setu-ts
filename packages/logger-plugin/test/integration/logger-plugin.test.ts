import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  IApplication,
  ILogger,
  IPluginContext,
  IRuntimeServices,
  MiddlewareFunction,
  MiddlewareOptions,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';
import { NoopLogger } from '../../src/loggers/noop-logger.ts';
import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import type { PinoFactory } from '../../src/loggers/pino-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/**
 * Fake plugin context that records middleware additions and service registrations.
 */
function createFakeContext(runtime: IRuntimeServices): {
  ctx: IPluginContext;
  registeredServices: Map<string, unknown>;
  addedMiddleware: { fn: MiddlewareFunction; options?: MiddlewareOptions }[];
} {
  const registeredServices = new Map<string, unknown>();
  const addedMiddleware: { fn: MiddlewareFunction; options?: MiddlewareOptions }[] = [];

  const ctx: IPluginContext = {
    runtime,
    services: {
      register<T extends object>(token: string, service: T): void {
        registeredServices.set(token, service);
      },
      registerFactory<T extends object>(_token: string, _factory: () => T): void {},
      get<T extends object>(token: string): T {
        if (token === CAPABILITIES.RUNTIME) {
          return runtime as T;
        }
        return registeredServices.get(token) as T;
      },
      getAll<T extends object>(_token: string): readonly T[] {
        return [];
      },
      has(token: string): boolean {
        return token === CAPABILITIES.RUNTIME || registeredServices.has(token);
      },
      unregister(_token: string): boolean {
        return false;
      },
    },
    middleware: {
      add(fn: MiddlewareFunction, options?: MiddlewareOptions): void {
        const entry: { fn: MiddlewareFunction; options?: MiddlewareOptions } = { fn };
        if (options !== undefined) {
          entry.options = options;
        }
        addedMiddleware.push(entry);
      },
    },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    lifecycle: {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as unknown as IApplication,
  };

  return { ctx, registeredServices, addedMiddleware };
}

/**
 * Retrieves a registered service as a typed logger.
 */
function getLogger(map: Map<string, unknown>): ILogger {
  return map.get(CAPABILITIES.LOGGER) as ILogger;
}

describe('LoggerPlugin (integration)', () => {
  let runtime: IRuntimeServices;

  beforeEach(() => {
    runtime = createFakeRuntime().runtime;
  });

  it('returns a plugin with the correct metadata', () => {
    const plugin = LoggerPlugin();
    expect(plugin.name).toBe('logger-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.dependencies).toEqual(['runtime']);
    expect(plugin.provides).toEqual([CAPABILITIES.LOGGER]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.HIGH);
  });

  it('registers an ILogger under CAPABILITIES.LOGGER', async () => {
    const plugin = LoggerPlugin({ transport: 'noop' });
    const { ctx, registeredServices } = createFakeContext(runtime);
    await plugin.register(ctx);

    expect(registeredServices.has(CAPABILITIES.LOGGER)).toBe(true);
    const logger = getLogger(registeredServices);
    expect(logger).toBeDefined();
  });

  it('registers a NoopLogger when transport is noop', async () => {
    const plugin = LoggerPlugin({ transport: 'noop' });
    const { ctx, registeredServices } = createFakeContext(runtime);
    await plugin.register(ctx);

    const logger = getLogger(registeredServices);
    expect(logger).toBeInstanceOf(NoopLogger);
  });

  it('registers a ConsoleLogger when transport is console (default)', async () => {
    const plugin = LoggerPlugin();
    const { ctx, registeredServices } = createFakeContext(runtime);
    await plugin.register(ctx);

    const logger = getLogger(registeredServices);
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it('passes level option to the logger', async () => {
    const plugin = LoggerPlugin({ transport: 'noop', level: 'error' });
    const { ctx, registeredServices } = createFakeContext(runtime);
    await plugin.register(ctx);

    const logger = getLogger(registeredServices);
    expect(logger.level).toBe('error');
  });

  it('registers a ConsoleLogger with pretty and redact options', async () => {
    const plugin = LoggerPlugin({
      transport: 'console',
      level: 'debug',
      pretty: true,
      redact: ['password'],
    });
    const { ctx, registeredServices } = createFakeContext(runtime);
    await plugin.register(ctx);

    const logger = getLogger(registeredServices);
    expect(logger).toBeInstanceOf(ConsoleLogger);
    expect(logger.level).toBe('debug');
  });

  it('registers a PinoLogger when transport is pino', async () => {
    // Inject a fake Pino factory via the pinoFactory option.
    const fakePino = {
      level: 'info',
      fatal() {},
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return fakePino;
      },
    };
    const factory: PinoFactory = () => fakePino;

    const plugin = LoggerPlugin({
      transport: 'pino',
      level: 'warn',
      redact: ['token'],
      pinoFactory: factory,
    });
    const { ctx, registeredServices } = createFakeContext(runtime);

    // register() is now async for pino transport (await PinoLogger.create).
    await plugin.register(ctx);

    expect(registeredServices.has(CAPABILITIES.LOGGER)).toBe(true);
    const logger = getLogger(registeredServices);
    expect(logger.level).toBe('warn');
  });

  it('registers a PinoLogger with requestLogging middleware', async () => {
    const fakePino = {
      level: 'info',
      fatal() {},
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return fakePino;
      },
    };
    const factory: PinoFactory = () => fakePino;

    const plugin = LoggerPlugin({
      transport: 'pino',
      requestLogging: true,
      slowRequestThreshold: 200,
      excludePaths: ['/metrics'],
      pinoFactory: factory,
    });
    const { ctx, addedMiddleware } = createFakeContext(runtime);

    await plugin.register(ctx);

    expect(addedMiddleware.length).toBe(1);
    expect(addedMiddleware[0]!.options!.name).toBe('request-logger');
  });

  it('does not register middleware when requestLogging is false (default)', async () => {
    const plugin = LoggerPlugin({ transport: 'noop' });
    const { ctx, addedMiddleware } = createFakeContext(runtime);
    await plugin.register(ctx);

    expect(addedMiddleware.length).toBe(0);
  });

  it('registers request-logger middleware when requestLogging is true', async () => {
    const plugin = LoggerPlugin({ transport: 'noop', requestLogging: true });
    const { ctx, addedMiddleware } = createFakeContext(runtime);
    await plugin.register(ctx);

    expect(addedMiddleware.length).toBe(1);
    expect(addedMiddleware[0]!.options!.name).toBe('request-logger');
    expect(addedMiddleware[0]!.options!.priority).toBe(PLUGIN_PRIORITY.HIGH);
  });

  it('passes slowRequestThreshold and excludePaths to the middleware', async () => {
    const plugin = LoggerPlugin({
      transport: 'noop',
      requestLogging: true,
      slowRequestThreshold: 100,
      excludePaths: ['/health'],
    });
    const { ctx, addedMiddleware } = createFakeContext(runtime);
    await plugin.register(ctx);

    expect(addedMiddleware.length).toBe(1);
    // We can't easily introspect the middleware function's options, but we
    // can verify it was registered. The behavior is covered by unit tests.
  });

  it('throws if runtime is not registered', async () => {
    const plugin = LoggerPlugin({ transport: 'noop' });
    // The plugin resolves CAPABILITIES.RUNTIME via ctx.services.get(), which
    // throws here. ctx.runtime is mandatory on IPluginContext but the plugin
    // uses the registry, so we provide a stub that also throws if touched.
    const throwingRuntime = {
      platform: () => 'deno',
    } as unknown as IRuntimeServices;
    const ctx: IPluginContext = {
      runtime: throwingRuntime,
      services: {
        register<T extends object>(_token: string, _service: T): void {},
        registerFactory<T extends object>(_token: string, _factory: () => T): void {},
        get<T extends object>(_token: string): T {
          throw new Error('not found');
        },
        getAll<T extends object>(_token: string): readonly T[] {
          return [];
        },
        has(_token: string): boolean {
          return false;
        },
        unregister(_token: string): boolean {
          return false;
        },
      },
      middleware: { add: () => {} },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      lifecycle: {
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onShutdown: () => {},
        onClose: () => {},
      },
      health: { register: () => {} },
      metrics: { register: () => {} },
      openapi: { addSchema: () => {} },
      decorators: { register: () => {} },
      cli: { register: () => {} },
      environment: { validate: () => {} },
      options: {},
      app: {} as unknown as IApplication,
    };

    await expect(plugin.register(ctx)).rejects.toThrow();
  });
});

/**
 * Fake plugin context fixture for di-plugin integration tests.
 *
 * Provides a Map-backed IServiceRegistry so the DiPlugin can register its
 * container and the test can verify the registration and exercise
 * autoRegister fallback.
 *
 * @module
 */
import type {
  IApplication,
  IPluginContext,
  IRuntimeServices,
  IServiceRegistry,
  MiddlewareFunction,
  MiddlewareOptions,
  RuntimePlatform,
  TimerHandle,
} from '@hono-enterprise/common';

/**
 * Creates a minimal fake runtime for the context (the DI plugin does not
 * use runtime services, but IPluginContext requires it).
 */
function createFakeRuntime(): IRuntimeServices {
  return {
    platform: (): RuntimePlatform => 'deno',
    version: () => '2.0.0-fake',
    hostname: () => 'test-host',
    uuid: () => 'fake-uuid',
    randomBytes: (length: number) => new Uint8Array(length),
    get subtle(): SubtleCrypto {
      throw new Error('SubtleCrypto not available in fake runtime');
    },
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (_fn: () => void, _ms: number): TimerHandle => 0,
    clearTimeout: (_handle: TimerHandle): void => {},
    setInterval: (_fn: () => void, _ms: number): TimerHandle => 0,
    clearInterval: (_handle: TimerHandle): void => {},
    env: {},
    exit: () => {
      throw new Error('fake exit');
    },
  };
}

/**
 * Creates a fake plugin context with a Map-backed service registry.
 *
 * @returns The context and the underlying map for assertions
 */
export function createFakeContext(): {
  ctx: IPluginContext;
  services: Map<string, unknown>;
  middleware: { fn: MiddlewareFunction; options?: MiddlewareOptions }[];
} {
  const services = new Map<string, unknown>();
  const middleware: { fn: MiddlewareFunction; options?: MiddlewareOptions }[] = [];
  const runtime = createFakeRuntime();

  const serviceRegistry: IServiceRegistry = {
    register<T extends object>(token: string, service: T): void {
      services.set(token, service);
    },
    registerFactory<T extends object>(token: string, factory: () => T): void {
      services.set(token, factory());
    },
    get<T extends object>(token: string): T {
      const svc = services.get(token);
      if (svc === undefined) {
        throw new Error(`Service '${token}' not registered`);
      }
      return svc as T;
    },
    getAll<T extends object>(token: string): readonly T[] {
      const svc = services.get(token);
      return svc !== undefined ? [svc as T] : [];
    },
    has(token: string): boolean {
      return services.has(token);
    },
    unregister(token: string): boolean {
      return services.delete(token);
    },
  };

  const ctx: IPluginContext = {
    runtime,
    services: serviceRegistry,
    middleware: {
      add(fn: MiddlewareFunction, options?: MiddlewareOptions): void {
        const entry: { fn: MiddlewareFunction; options?: MiddlewareOptions } = { fn };
        if (options !== undefined) {
          entry.options = options;
        }
        middleware.push(entry);
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

  return { ctx, services, middleware };
}

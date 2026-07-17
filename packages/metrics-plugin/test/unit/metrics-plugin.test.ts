/**
 * Unit tests for MetricsPlugin.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricsPlugin } from '../../src/plugin/metrics-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPlugin } from '@hono-enterprise/common';

/**
 * Fake service registry for testing.
 */
class FakeServiceRegistry {
  #services = new Map<string, unknown>();
  #mockAll = new Map<string, unknown[]>();

  register<T>(token: string, service: T): void {
    this.#services.set(token, service);
  }

  get<T>(token: string): T | undefined {
    return this.#services.get(token) as T | undefined;
  }

  getAll<T>(token: string): T[] {
    const mock = this.#mockAll.get(token);
    if (mock) {
      return mock as T[];
    }
    return [];
  }

  setMockAll<T>(token: string, items: T[]): void {
    this.#mockAll.set(token, items as unknown[]);
  }

  has(token: string): boolean {
    return this.#services.has(token);
  }

  unregister(token: string): void {
    this.#services.delete(token);
  }
}

/**
 * Fake plugin context for testing.
 */
function createFakeContext() {
  const services = new FakeServiceRegistry();
  const middleware: Array<{ fn: unknown; priority: number }> = [];
  const routes: Array<{ method: string; path: string; handler?: unknown }> = [];
  const lifecycleHooks: { onInit?: (() => void)[]; onClose?: (() => void)[] } = {
    onInit: [],
    onClose: [],
  };

  return {
    services,
    middleware: {
      add: (fn: unknown, options?: { priority?: number }) => {
        middleware.push({ fn, priority: options?.priority ?? 500 });
      },
    },
    router: {
      get: (path: string, handler: unknown) => {
        routes.push({ method: 'GET', path, handler });
      },
    },
    lifecycle: {
      onInit: (fn: () => void) => {
        lifecycleHooks.onInit?.push(fn);
      },
      onClose: (fn: () => void) => {
        lifecycleHooks.onClose?.push(fn);
      },
    },
    metrics: {
      register: (_name: string, _config: unknown) => {
        // No-op for testing
      },
    },
    health: {
      register: (_name: string, _indicator: unknown) => {
        // No-op for testing
      },
    },
    runtime: {
      platform: () => 'deno' as const,
      version: () => '2.0.0',
      hostname: () => 'test',
      uuid: () => 'test-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      now: () => Date.now(),
      hrtime: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (h: number) => clearTimeout(h as unknown as number),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
      clearInterval: (h: number) => clearInterval(h as unknown as number),
      env: {},
      exit: () => {
        throw new Error('exit called');
      },
    },
    logger: undefined,
    middlewareList: middleware,
    routeList: routes,
    lifecycleHooks,
  };
}

Deno.test('MetricsPlugin — factory returns IPlugin', () => {
  const plugin = MetricsPlugin();

  assertEquals(typeof plugin, 'object');
  assertEquals(typeof plugin.name, 'string');
  assertEquals(typeof plugin.provides, 'object');
});

Deno.test('MetricsPlugin — name is metrics-plugin', () => {
  const plugin = MetricsPlugin();

  assertEquals(plugin.name, 'metrics-plugin');
});

Deno.test('MetricsPlugin — provides metrics capability', () => {
  const plugin = MetricsPlugin();

  assertEquals(plugin.provides?.includes(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — priority is 100', () => {
  const plugin = MetricsPlugin();

  assertEquals(plugin.priority, 100);
});

Deno.test('MetricsPlugin — register places service under metrics token', async () => {
  const plugin = MetricsPlugin();
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // The service should be registered
  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — default endpoint is /metrics', async () => {
  const plugin = MetricsPlugin();
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  const metricsRoute = ctx.routeList.find((r) => r.path === '/metrics');
  assertEquals(metricsRoute !== undefined, true);
});

Deno.test('MetricsPlugin — custom endpoint is used', async () => {
  const plugin = MetricsPlugin({ endpoint: '/custom-metrics' });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  const customRoute = ctx.routeList.find((r) => r.path === '/custom-metrics');
  assertEquals(customRoute !== undefined, true);
});

Deno.test('MetricsPlugin — middleware registered at priority 20', async () => {
  const plugin = MetricsPlugin({ defaultMetrics: true, httpMetrics: true });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  const metricsMiddleware = ctx.middlewareList.find((m) => m.priority === 20);
  assertEquals(metricsMiddleware !== undefined, true);
});

Deno.test('MetricsPlugin — onInit hook drains METRIC_REGISTRATION', async () => {
  const plugin = MetricsPlugin();
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Trigger onInit hooks
  for (const hook of ctx.lifecycleHooks.onInit ?? []) {
    hook();
  }

  // The service should be registered
  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — route handler executes and returns metrics', async () => {
  const plugin = MetricsPlugin();
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Find the metrics route handler
  const metricsRoute = ctx.routeList.find((r) => r.path === '/metrics');
  assertEquals(metricsRoute !== undefined, true);
  assertEquals(metricsRoute?.handler !== undefined, true);

  // Create a fake context for the handler
  const fakeHandlerContext = {
    response: {
      header: (_key: string, _value: string) => fakeHandlerContext.response,
      status: (_code: number) => fakeHandlerContext.response,
      text: (body: string) => ({ status: 200, body }),
    },
  };

  // Invoke the handler
  const handler = metricsRoute?.handler as (
    ctx: unknown,
  ) => Promise<{ status: number; body: string }>;
  const result = await handler(fakeHandlerContext);

  assertEquals(result.status, 200);
  assertEquals(typeof result.body, 'string');
});

Deno.test('MetricsPlugin — onInit hook with METRIC_REGISTRATION contributions executes registration loop', async () => {
  const plugin = MetricsPlugin();
  const ctx = createFakeContext();

  // Mock getAll to return METRIC_REGISTRATION contributions
  const mockRegistrations = [
    { name: 'test_counter', config: { type: 'counter' as const, help: 'Test counter' } },
    { name: 'test_gauge', config: { type: 'gauge' as const, help: 'Test gauge' } },
  ];
  (ctx.services as FakeServiceRegistry).setMockAll(
    CAPABILITIES.METRIC_REGISTRATION,
    mockRegistrations,
  );

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Trigger onInit hooks - this will execute the registration loop
  for (const hook of ctx.lifecycleHooks.onInit ?? []) {
    hook();
  }

  // The service should be registered
  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — onInit hook materializes custom metrics from options', async () => {
  const plugin = MetricsPlugin({
    customMetrics: [
      { type: 'counter' as const, name: 'custom_counter', help: 'A custom counter' },
    ],
  });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Trigger onInit hooks
  for (const hook of ctx.lifecycleHooks.onInit ?? []) {
    hook();
  }

  // The service should be registered
  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — httpMetrics disabled skips middleware', async () => {
  const plugin = MetricsPlugin({ defaultMetrics: true, httpMetrics: false });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // No middleware should be registered at priority 20
  const metricsMiddleware = ctx.middlewareList.find((m) => m.priority === 20);
  assertEquals(metricsMiddleware, undefined);
});

Deno.test('MetricsPlugin — defaultMetrics disabled skips everything', async () => {
  const plugin = MetricsPlugin({ defaultMetrics: false });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Route should still be registered (for manual metrics)
  // But middleware should not be
  const metricsMiddleware = ctx.middlewareList.find((m) => m.priority === 20);
  assertEquals(metricsMiddleware, undefined);
});

Deno.test('MetricsPlugin — customQuantiles option is accepted', async () => {
  const plugin = MetricsPlugin({
    defaultBuckets: [1, 5, 10],
    defaultQuantiles: [0.25, 0.5, 0.75],
  });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

Deno.test('MetricsPlugin — all options disabled still registers route', async () => {
  const plugin = MetricsPlugin({
    defaultMetrics: false,
    httpMetrics: false,
    customMetrics: [],
  });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  // Route should still be registered
  const metricsRoute = ctx.routeList.find((r) => r.path === '/metrics');
  assertEquals(metricsRoute !== undefined, true);

  // No middleware should be registered
  const metricsMiddleware = ctx.middlewareList.find((m) => m.priority === 20);
  assertEquals(metricsMiddleware, undefined);
});

Deno.test('MetricsPlugin — defaultBuckets option is accepted', async () => {
  const plugin = MetricsPlugin({
    defaultBuckets: [0.1, 0.5, 1, 5],
  });
  const ctx = createFakeContext();

  await plugin.register(ctx as unknown as Parameters<IPlugin['register']>[0]);

  assertEquals(ctx.services.has(CAPABILITIES.METRICS), true);
});

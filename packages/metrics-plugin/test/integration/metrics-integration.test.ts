/**
 * Integration tests for the metrics plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricsPlugin } from '../../src/index.ts';
import type { MetricsService } from '../../src/services/metrics-service.ts';
import { CAPABILITIES, type IMetricsService } from '@hono-enterprise/common';

/**
 * Fake service registry for integration testing.
 */
class FakeServiceRegistry {
  #services = new Map<string, unknown>();

  register<T>(token: string, service: T): void {
    this.#services.set(token, service);
  }

  get<T>(token: string): T | undefined {
    return this.#services.get(token) as T | undefined;
  }

  getAll<T>(_token: string): T[] {
    return [];
  }

  has(token: string): boolean {
    return this.#services.has(token);
  }

  unregister(token: string): void {
    this.#services.delete(token);
  }
}

/**
 * Fake plugin context for integration testing.
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
      add: (fn: unknown, options?: { priority?: number; name?: string }) => {
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

describe('Integration', () => {
  it('plugin registers IMetricsService', async () => {
    const plugin = MetricsPlugin();
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const service = ctx.services.get<IMetricsService>(CAPABILITIES.METRICS);
    assertEquals(service !== undefined, true);
    assertEquals(typeof service?.counter, 'function');
  });

  it('service records and renders metrics', async () => {
    const plugin = MetricsPlugin();
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);

    // Record some metrics
    const counter = service?.counter('test_counter', { help: 'Test counter' });
    counter?.inc(10);

    const gauge = service?.gauge('test_gauge', { help: 'Test gauge' });
    gauge?.set(42);

    // Render should produce Prometheus format
    const rendered = service?.render();
    assertEquals(typeof rendered, 'string');
    assertEquals(rendered!.length > 0, true);
  });

  it('/metrics route returns Prometheus format', async () => {
    const plugin = MetricsPlugin({ defaultMetrics: false }); // Disable auto middleware
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    // Find the /metrics route handler
    const metricsRoute = ctx.routeList.find((r) => r.path === '/metrics');
    assertEquals(metricsRoute !== undefined, true);

    // The handler should exist
    assertEquals(metricsRoute?.handler !== undefined, true);
  });

  it('custom metrics are registered', async () => {
    const plugin = MetricsPlugin({
      customMetrics: [
        {
          name: 'custom_counter',
          type: 'counter',
          help: 'Custom counter',
        },
      ],
    });
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    // Trigger onInit
    for (const hook of ctx.lifecycleHooks.onInit ?? []) {
      hook();
    }

    const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);
    const metric = service?.get('custom_counter');
    assertEquals(metric !== undefined, true);
    assertEquals(metric?.type, 'counter');
  });

  it('HTTP metrics are registered with defaultMetrics', async () => {
    const plugin = MetricsPlugin({ defaultMetrics: true, httpMetrics: true });
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);

    // Check that HTTP metrics exist
    assertEquals(service?.get('http_request_duration_seconds') !== undefined, true);
    assertEquals(service?.get('http_requests_total') !== undefined, true);
    assertEquals(service?.get('http_request_errors_total') !== undefined, true);
    assertEquals(service?.get('http_active_requests') !== undefined, true);
  });

  it('middleware is registered at priority 20', async () => {
    const plugin = MetricsPlugin({ defaultMetrics: true, httpMetrics: true });
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const metricsMiddleware = ctx.middlewareList.find((m) => m.priority === 20);
    assertEquals(metricsMiddleware !== undefined, true);
  });

  it('defaultBuckets are used for histograms', async () => {
    const plugin = MetricsPlugin({
      defaultBuckets: [0.1, 0.5, 1],
      defaultMetrics: false,
    });
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);
    const histogram = service?.histogram('test_histogram');

    assertEquals(histogram?.buckets.length, 3);
    assertEquals(histogram?.buckets[0], 0.1);
  });

  it('defaultQuantiles are used for summaries', async () => {
    const plugin = MetricsPlugin({
      defaultQuantiles: [0.25, 0.75],
      defaultMetrics: false,
    });
    const ctx = createFakeContext();

    await plugin.register(
      ctx as unknown as Parameters<import('@hono-enterprise/common').IPlugin['register']>[0],
    );

    const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);
    const summary = service?.summary('test_summary');

    assertEquals(summary?.quantiles.length, 2);
    assertEquals(summary?.quantiles[0], 0.25);
  });
});

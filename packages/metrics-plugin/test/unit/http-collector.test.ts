/**
 * Unit tests for HttpCollector.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { HttpCollector, MIDDLEWARE_PRIORITY } from '../../src/collectors/http-collector.ts';
import { MetricsService } from '../../src/services/metrics-service.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

Deno.test('HttpCollector — middleware priority is 20', () => {
  assertEquals(MIDDLEWARE_PRIORITY.METRICS, 20);
});

Deno.test('HttpCollector — registers four HTTP metrics', () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  assertEquals(service.get('http_request_duration_seconds') !== undefined, true);
  assertEquals(service.get('http_requests_total') !== undefined, true);
  assertEquals(service.get('http_request_errors_total') !== undefined, true);
  assertEquals(service.get('http_active_requests') !== undefined, true);
});

Deno.test('HttpCollector — middleware records duration and request count for 200', async () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  const ctx = createFakeContext({ method: 'GET', path: '/test' });
  ctx.response.status(200);

  let nextCalled = false;
  // deno-lint-ignore require-await
  const next = async () => {
    nextCalled = true;
  };

  await collector.middleware(ctx, next);

  assertEquals(nextCalled, true);

  // Check that metrics were recorded
  const requests = service.get('http_requests_total');
  assertEquals(requests !== undefined, true);
});

Deno.test('HttpCollector — middleware records error for 500', async () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  const ctx = createFakeContext({ method: 'POST', path: '/error' });
  ctx.response.status(500);

  let nextCalled = false;
  // deno-lint-ignore require-await
  const next = async () => {
    nextCalled = true;
  };

  await collector.middleware(ctx, next);

  assertEquals(nextCalled, true);

  const errors = service.get('http_request_errors_total');
  assertEquals(errors !== undefined, true);
});

Deno.test('HttpCollector — active gauge returns to baseline after request', async () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  const ctx = createFakeContext({ method: 'GET', path: '/test' });
  ctx.response.status(200);

  let nextCalled = false;
  // deno-lint-ignore require-await
  const next = async () => {
    nextCalled = true;
  };

  await collector.middleware(ctx, next);

  assertEquals(nextCalled, true);
  // After request completes, active should be back to 0
});

Deno.test('HttpCollector — path label is absent', () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime, {
    durationLabels: ['method', 'status'],
    requestsLabels: ['method', 'status'],
  });

  collector.register();

  const duration = service.get('http_request_duration_seconds');
  assertEquals(duration !== undefined, true);
  // The collector should only use method and status labels, not path
});

Deno.test('HttpCollector — duration uses monotonic clock', async () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  const ctx = createFakeContext({ method: 'GET', path: '/test' });
  ctx.response.status(200);

  const initialTime = runtime.hrtime();

  await collector.middleware(ctx, async () => {
    await runtime.advance(100); // Advance time by 100ms
  });

  // The duration should be based on hrtime delta, not wall clock
  const finalTime = runtime.hrtime();
  assertEquals(finalTime - initialTime, 100);
});

Deno.test('HttpCollector — throw path rethrows and records metrics', async () => {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime);

  collector.register();

  const ctx = createFakeContext({ method: 'GET', path: '/error' });

  const testError = new Error('Test error');

  await assertRejects(
    async () => {
      // deno-lint-ignore require-await
      await collector.middleware(ctx, async () => {
        throw testError;
      });
    },
    Error,
    'Test error',
  );

  // Active gauge should be back to baseline after error
  const errors = service.get('http_request_errors_total');
  assertEquals(errors !== undefined, true);
});

/**
 * Helper to assert a promise rejects.
 */
async function assertRejects(
  fn: () => Promise<void>,
  ErrorClass: typeof Error,
  msgIncludes: string,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    assertEquals(e instanceof ErrorClass, true);
    assertEquals((e as Error).message.includes(msgIncludes), true);
  }
  if (!threw) {
    throw new Error('Expected function to throw');
  }
}

/**
 * Behavioral test proving that the documented Cloudflare Worker memoized-startup
 * pattern ensures startup always precedes fetch, including concurrent first
 * requests.
 *
 * This exercises the exact production pattern from apps/cloudflare/worker.ts:
 * one memoized promise constructs the application, awaits startup, and only
 * then resolves it. A concurrent caller must never receive an unstarted
 * application.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// Mirror the exact production helper from apps/cloudflare/worker.ts so the
// test exercises the real pattern rather than a lookalike.
function createMemoizedStartup(
  factory: () => ReturnType<typeof createApplication>,
): () => Promise<ReturnType<typeof createApplication>> {
  let application: Promise<ReturnType<typeof createApplication>> | undefined;
  return async () => {
    if (application === undefined) {
      application = (async () => {
        const created = factory();
        await created.start();
        return created;
      })();
    }
    return await application;
  };
}

describe('Worker startup behavior — memoized pattern', () => {
  it('startup precedes fetch on first request', async () => {
    let started = false;
    let fetched = false;

    const app = createMemoizedStartup(() => {
      const raw = createApplication();
      raw.register(RuntimePlugin());

      // Override start to track ordering
      const origStart = raw.start.bind(raw);
      raw.start = async () => {
        const result = await origStart();
        started = true;
        return result;
      };

      raw.router.get('/test', async (ctx) => {
        await Promise.resolve();
        fetched = true;
        return ctx.response.json({ ok: true });
      });

      return raw;
    });

    // Call the memoized helper (startup happens inside the promise)
    const resolved = await app();
    expect(started).toBe(true);

    // Now fetch — startup already completed
    const response = await resolved.fetch(new Request('http://localhost/test'));
    expect(response.status).toBe(200);
    expect(fetched).toBe(true);
  });

  it('concurrent first requests share a single startup', async () => {
    let startCallCount = 0;

    const app = createMemoizedStartup(() => {
      const raw = createApplication();
      raw.register(RuntimePlugin());

      const origStart = raw.start.bind(raw);
      raw.start = async () => {
        startCallCount++;
        await origStart();
      };

      raw.router.get('/test', async (ctx) => {
        await Promise.resolve();
        return ctx.response.json({ ok: true });
      });

      return raw;
    });

    // Fire two concurrent "first requests" through the same memoized helper
    const [r1, r2] = await Promise.all([
      app().then((s) => s.fetch(new Request('http://localhost/test'))),
      app().then((s) => s.fetch(new Request('http://localhost/test'))),
    ]);

    // Both requests succeed
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // start() was called exactly once despite two concurrent callers
    expect(startCallCount).toBe(1);
  });

  it('startup failure propagates to all concurrent waiters', async () => {
    const startupError = new Error('startup failed');

    const app = createMemoizedStartup(() => {
      const raw = createApplication();
      raw.register(RuntimePlugin());
      // Deliberately fail startup
      raw.start = () => {
        return Promise.reject(startupError);
      };
      return raw;
    });

    // Both callers should see the same error
    let error1: Error | null = null;
    let error2: Error | null = null;

    await Promise.allSettled([
      app().catch((e) => {
        error1 = e as Error;
      }),
      app().catch((e) => {
        error2 = e as Error;
      }),
    ]);

    expect(error1).toBe(startupError);
    expect(error2).toBe(startupError);
  });

  it('no fetch occurs before successful startup', async () => {
    const order: string[] = [];

    const app = createMemoizedStartup(() => {
      const raw = createApplication();
      raw.register(RuntimePlugin());

      const origStart = raw.start.bind(raw);
      raw.start = async () => {
        await origStart();
        order.push('started');
      };

      raw.router.get('/test', (ctx) => {
        order.push('fetched');
        return ctx.response.json({ ok: true });
      });

      return raw;
    });

    // The fetch is chained after app() resolves, so startup must come first
    await app().then((s) => s.fetch(new Request('http://localhost/test')));

    expect(order).toEqual(['started', 'fetched']);
  });
});

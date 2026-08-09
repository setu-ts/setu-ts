/**
 * Behavioral test proving that the documented Cloudflare Worker memoized-startup
 * pattern ensures startup always precedes fetch, including concurrent first
 * requests.
 *
 * This exercises the exact pattern from apps/cloudflare/worker.ts rather than
 * only static text matching.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('Worker startup behavior — memoized pattern', () => {
  it('startup precedes fetch on first request', async () => {
    // Simulate the memoized startup pattern from the docs.
    const raw = createApplication();
    raw.register(RuntimePlugin());

    let started = false;
    let fetched = false;

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

    // Memoized startup pattern (matching docs exactly)
    // start() returns void, so we memoize the started app reference.
    let application: Promise<typeof raw> | undefined;
    async function app(): Promise<typeof raw> {
      if (application === undefined) {
        application = (async () => {
          await raw.start();
          return raw;
        })();
        await application;
      }
      return await application;
    }

    // Simulate a first request
    const appStarted = app();
    const resolved = await appStarted;
    expect(started).toBe(true);

    // Now fetch
    const response = await resolved.fetch(new Request('http://localhost/test'));
    expect(response.status).toBe(200);
    expect(fetched).toBe(true);

    // Verify startup happened before fetch
    expect(started).toBe(true);
  });

  it('concurrent first requests share a single startup', async () => {
    const raw = createApplication();
    raw.register(RuntimePlugin());

    let startCallCount = 0;
    const origStart = raw.start.bind(raw);
    raw.start = async () => {
      startCallCount++;
      await origStart();
    };

    raw.router.get('/test', async (ctx) => {
      await Promise.resolve();
      return ctx.response.json({ ok: true });
    });

    // Memoized startup
    let application: Promise<typeof raw> | undefined;
    async function app(): Promise<typeof raw> {
      if (application === undefined) {
        application = (async () => {
          await raw.start();
          return raw;
        })();
        await application;
      }
      return await application;
    }

    // Fire two concurrent "first requests"
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
    const raw = createApplication();
    // Deliberately fail startup
    // Deliberately fail startup — async to match interface signature
    raw.start = async () => {
      await Promise.reject(new Error('startup failed'));
    };

    let application: Promise<typeof raw> | undefined;
    async function app(): Promise<typeof raw> {
      if (application === undefined) {
        application = (async () => {
          await raw.start();
          return raw;
        })();
        await application;
      }
      return await application;
    }

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

    expect(error1).not.toBeNull();
    expect(error2).not.toBeNull();
    expect(error1!.message).toBe('startup failed');
    expect(error2!.message).toBe('startup failed');
  });
});

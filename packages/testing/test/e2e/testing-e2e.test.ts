import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '../../src/test-app.ts';
import { collectStream, inject } from '../../src/inject.ts';
import { createTestContext } from '../../src/mock-context.ts';
import { FixtureManager } from '../../src/fixtures/fixture-manager.ts';
import { CAPABILITIES } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('testing package — e2e', () => {
  it('full flow: inject non-streaming, fetch streaming via collectStream, context, and fixture manager', async () => {
    const fixtures = new FixtureManager();
    fixtures.mock('database', { query: () => [{ id: 1, name: 'Alice' }] });
    fixtures.mock('cache', { get: () => null, set: () => {} });

    // Use the real RuntimePlugin for end-to-end testing on Deno — this is the
    // tier where exercising real dependencies is the point. fetch() requires
    // an HTTP adapter, which only the real RuntimePlugin provides.
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        ...fixtures.plugins(),
      ],
    });

    // Register routes on the started app (post-start, verified in integration tests)
    app.router.get('/users', (ctx) => {
      const db = ctx.services.get<{ query: () => Array<{ id: number; name: string }> }>(
        CAPABILITIES.DATABASE,
      );
      return ctx.response.json(db.query());
    });

    // Exercise inject (non-streaming)
    const injectRes = await inject(app, '/users');
    expect(injectRes.statusCode).toBe(200);
    const users = injectRes.json<Array<{ id: number; name: string }>>();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('Alice');

    // Register a streaming route
    app.router.get('/stream', (ctx) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'));
          controller.enqueue(new TextEncoder().encode('chunk2'));
          controller.close();
        },
      });
      return ctx.response.stream(stream);
    });

    // Exercise fetch + collectStream (streaming)
    const fetchRes = await app.fetch(new Request('http://localhost/stream'));
    const streamed = await collectStream(fetchRes);
    expect(streamed.chunks).toHaveLength(2);
    expect(streamed.text).toBe('chunk1chunk2');

    // Exercise createTestContext (unit-style middleware test inside e2e)
    const ctx = createTestContext();
    expect(ctx.id).toBe('test-ctx');
    expect(ctx.startTime).toBe(0);
    expect(ctx.params).toEqual({});
    expect(ctx.state).toBeInstanceOf(Map);

    await app.stop();
  });

  it('FixtureManager reset works between scenarios', () => {
    const fixtures = new FixtureManager();
    fixtures.mock('db1', { n: 1 });
    expect(fixtures.plugins()).toHaveLength(1);

    fixtures.reset();
    expect(fixtures.plugins()).toHaveLength(0);

    fixtures.mock('db2', { n: 2 });
    expect(fixtures.plugins()).toHaveLength(1);
    expect(fixtures.plugins()[0].name).toBe('db2');
  });
});

/**
 * The HTTP idempotency middleware on a REAL kernel application (plan §3.6,
 * §3.8, §3.10): replay, a concurrent duplicate, a fingerprint mismatch, the
 * missing-key refusal, and the safe-method pass-through.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler, HttpError } from '@setu-ts/exceptions';
import { IdempotencyPlugin, idempotent } from '../../src/index.ts';

/** Builds an application with one idempotent POST route and a counter. */
async function buildApp(options?: Parameters<typeof idempotent>[0]) {
  const state = { count: 0 };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      IdempotencyPlugin(),
      {
        name: 'test-idempotent-routes',
        version: '1.0.0',
        register(ctx: IPluginContext): void {
          ctx.middleware.add(idempotent({ principal: 'optional', ...options }));
          ctx.router.post('/payments', (c) => {
            state.count++;
            return c.response.status(201).json({ id: 'pay-1', count: state.count });
          });
          ctx.router.get('/payments', (c) => c.response.json({ list: [] }));
        },
      },
    ],
  });
  await app.start();
  return { app, state };
}

describe('idempotent() on a real kernel (M109a §3.6, §3.8, §3.10)', () => {
  it('replays a completed response and runs the handler once', async () => {
    const { app, state } = await buildApp();
    try {
      const first = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k1' },
        body: '{"amount":1}',
      });
      expect(first.statusCode).toBe(201);
      expect(first.json<{ count: number }>().count).toBe(1);

      const second = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k1' },
        body: '{"amount":1}',
      });
      expect(second.statusCode).toBe(201);
      expect(second.headers.get('Idempotent-Replayed')).toBe('true');
      expect(second.json<{ count: number }>().count).toBe(1);
      expect(state.count).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('answers 422 for a different body under the same key', async () => {
    const { app } = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k2' },
        body: '{"amount":1}',
      });
      const mismatch = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k2' },
        body: '{"amount":2}',
      });
      expect(mismatch.statusCode).toBe(422);
    } finally {
      await app.stop();
    }
  });

  it('answers 400 for a missing key and passes a safe method through', async () => {
    const { app } = await buildApp();
    try {
      const missing = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        body: '{}',
      });
      expect(missing.statusCode).toBe(400);

      const get = await app.inject({ method: 'GET', url: 'http://localhost/payments' });
      expect(get.statusCode).toBe(200);
      expect(get.json<{ list: unknown[] }>().list).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('passes a request through unclaimed when required is false', async () => {
    const { app, state } = await buildApp({ required: false });
    try {
      const first = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        body: '{}',
      });
      const second = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        body: '{}',
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(state.count).toBe(2);
    } finally {
      await app.stop();
    }
  });
});

/** Identity middleware: the principal and the tenant come from headers. */
const identity: MiddlewareFunction = async (ctx, next) => {
  const user = ctx.request.headers.get('x-user');
  if (user !== null) ctx.request.user = { id: user };
  const tenant = ctx.request.headers.get('x-tenant');
  if (tenant !== null) ctx.request.tenant = { id: tenant };
  await next();
};

/** Polls until `predicate` holds, or fails the test rather than hanging. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A keyed POST carrying a principal, optionally a tenant. */
function keyedRequest(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': headers['Idempotency-Key'] as string, ...headers },
    body: '{"amount":1}',
  });
}

/**
 * The routes the response-level cases need, driven through `app.fetch` so the
 * REAL response mapper, the header filter and the status are exercised — not
 * only the `inject` shortcut.
 */
async function buildFetchApp() {
  const counts = { pay: 0, thrown400: 0, returned503: 0, slow: 0 };
  let releaseSlow: () => void = () => {};
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      IdempotencyPlugin(),
      {
        name: 'test-idempotent-fetch-routes',
        version: '1.0.0',
        register(ctx: IPluginContext): void {
          ctx.middleware.add(errorHandler({ format: 'rfc9457' }));
          ctx.middleware.add(identity);
          ctx.router.post('/payments', {
            middleware: [idempotent()],
            handler: (c) => {
              counts.pay++;
              c.response.header('Set-Cookie', 'sid=abc; Path=/');
              c.response.header('ETag', '"v1"');
              c.response.header('X-Custom', 'nope');
              return c.response.status(201).json({ id: `pay-${counts.pay}` });
            },
          });
          ctx.router.post('/thrown-400', {
            middleware: [idempotent()],
            handler: () => {
              counts.thrown400++;
              throw new HttpError(400, 'the caller sent a bad thing');
            },
          });
          ctx.router.post('/returned-503', {
            middleware: [idempotent()],
            handler: (c) => {
              counts.returned503++;
              return c.response.status(503).json({ busy: true });
            },
          });
          ctx.router.post('/slow', {
            middleware: [idempotent()],
            handler: async (c) => {
              counts.slow++;
              await new Promise<void>((resolve) => (releaseSlow = resolve));
              return c.response.status(201).json({ id: 'slow' });
            },
          });
        },
      },
    ],
  });
  await app.start();
  return { app, counts, release: () => releaseSlow() };
}

describe('idempotent() through app.fetch (M109a §3.6, §3.8, §3.10, §10 D1)', () => {
  it('answers one 201 and one 409 for concurrent requests on one key, then replays', async () => {
    const { app, counts, release } = await buildFetchApp();
    try {
      const headers = { 'Idempotency-Key': 'k-conc', 'x-user': 'alice' };
      const inFlight = app.fetch(keyedRequest('/slow', headers));
      await until(() => counts.slow === 1, 'the first request to claim');
      const duplicate = await app.fetch(keyedRequest('/slow', headers));
      expect(duplicate.status).toBe(409);
      release();
      expect((await inFlight).status).toBe(201);
      // The refused caller's retry now replays the completed record.
      const retry = await app.fetch(keyedRequest('/slow', headers));
      expect(retry.status).toBe(201);
      expect(retry.headers.get('Idempotent-Replayed')).toBe('true');
      expect(await retry.json()).toEqual({ id: 'slow' });
      expect(counts.slow).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('executes once for each principal and each tenant under one key (§10 obligation 1)', async () => {
    const { app, counts } = await buildFetchApp();
    try {
      const run = (user: string, tenant?: string) =>
        app.fetch(keyedRequest('/payments', {
          'Idempotency-Key': 'k-shared',
          'x-user': user,
          ...(tenant === undefined ? {} : { 'x-tenant': tenant }),
        }));
      expect((await run('alice')).status).toBe(201);
      expect((await run('bob')).status).toBe(201);
      expect((await run('alice', 'acme')).status).toBe(201);
      expect(counts.pay).toBe(3);
      // The first principal's OWN record still replays: isolation, not a hole.
      const replay = await run('alice');
      expect(replay.status).toBe(201);
      expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
      expect(counts.pay).toBe(3);
    } finally {
      await app.stop();
    }
  });

  it('re-executes after a THROWN 400 and after a RETURNED 503', async () => {
    const { app, counts } = await buildFetchApp();
    try {
      const run = (path: string, key: string) =>
        app.fetch(keyedRequest(path, { 'Idempotency-Key': key, 'x-user': 'alice' }));
      expect((await run('/thrown-400', 'k-thrown')).status).toBe(400);
      expect((await run('/thrown-400', 'k-thrown')).status).toBe(400);
      expect(counts.thrown400).toBe(2);
      expect((await run('/returned-503', 'k-503')).status).toBe(503);
      expect((await run('/returned-503', 'k-503')).status).toBe(503);
      expect(counts.returned503).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('replays without Set-Cookie or an unlisted header, and marks the replay', async () => {
    const { app, counts } = await buildFetchApp();
    try {
      const headers = { 'Idempotency-Key': 'k-headers', 'x-user': 'alice' };
      const first = await app.fetch(keyedRequest('/payments', headers));
      expect(first.status).toBe(201);
      expect(first.headers.get('set-cookie')).not.toBe(null);
      const replay = await app.fetch(keyedRequest('/payments', headers));
      expect(replay.status).toBe(201);
      expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
      expect(replay.headers.get('set-cookie')).toBe(null);
      expect(replay.headers.get('x-custom')).toBe(null);
      expect(replay.headers.get('etag')).toBe('"v1"');
      expect(await replay.json()).toEqual({ id: 'pay-1' });
      expect(counts.pay).toBe(1);
    } finally {
      await app.stop();
    }
  });
});

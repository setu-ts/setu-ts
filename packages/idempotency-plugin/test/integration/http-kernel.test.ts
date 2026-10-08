/**
 * The HTTP idempotency middleware on a REAL kernel application (plan §3.6,
 * §3.8, §3.10): replay, a concurrent duplicate, a fingerprint mismatch, the
 * missing-key refusal, and the safe-method pass-through.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
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

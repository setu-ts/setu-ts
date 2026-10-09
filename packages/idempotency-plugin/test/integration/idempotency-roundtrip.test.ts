/**
 * The SDK ↔ idempotency-plugin round trip (M109b §3.9): a dropped first
 * response, retried by the SDK with the SAME key, runs the handler once and
 * carries the replay header.
 *
 * Lives here rather than in `packages/sdk` because the SDK resolves
 * `@setu-ts/common` to its published `0.8.0`, so it cannot reach this
 * workspace's `IdempotencyPlugin` from inside its own package.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, MiddlewareFunction } from '@setu-ts/common';
import { createClient } from '@setu-ts/sdk';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin, idempotent } from '../../src/index.ts';

describe('SDK keyed retry through the plugin (M109b §3.9)', () => {
  it('retries a dropped response with the same key and runs the handler once', async () => {
    const state = { count: 0 };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin(),
        {
          name: 'roundtrip-routes',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(idempotent({ principal: 'optional' }));
            ctx.router.post('/charge', (c) => {
              state.count++;
              return c.response.status(201).json({ count: state.count });
            });
          },
        },
      ],
    });
    await app.start();
    try {
      let drop = true;
      const client = createClient({
        baseUrl: 'http://localhost',
        timing: { now: () => 0, sleep: () => Promise.resolve() },
        retry: { limit: 2, delay: 1, backoff: 'fixed' },
        fetch: (input, init) => {
          const request = new Request(input as string, init as RequestInit);
          if (drop) {
            // The server handled the request; the client loses the response.
            drop = false;
            return app.fetch(request).then(() => Promise.reject(new Error('connection reset')));
          }
          return app.fetch(request);
        },
      });

      const response = await client.request<{ count: number }>({
        method: 'POST',
        path: 'charge',
        json: { amount: 1 },
        idempotencyKey: 'rt-1',
      });

      expect(response.status).toBe(201);
      expect(response.data?.count).toBe(1);
      expect(state.count).toBe(1);
      // The retried attempt was served from the committed record.
      expect(response.headers.get('Idempotent-Replayed')).toBe('true');
    } finally {
      await app.stop();
    }
  });

  it('does not retry an unkeyed POST', async () => {
    let entered = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin(),
        {
          name: 'roundtrip-unkeyed',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            const middleware: MiddlewareFunction = idempotent({ principal: 'optional' });
            ctx.middleware.add(middleware);
            ctx.router.post('/charge', (c) => {
              entered++;
              return c.response.status(201).json({ count: entered });
            });
          },
        },
      ],
    });
    await app.start();
    try {
      let attempts = 0;
      const client = createClient({
        baseUrl: 'http://localhost',
        timing: { now: () => 0, sleep: () => Promise.resolve() },
        retry: { limit: 3, delay: 1, backoff: 'fixed' },
        fetch: (input, init) => {
          attempts++;
          // Always drop, so an unkeyed POST must NOT be retried.
          return app.fetch(new Request(input as string, init as RequestInit)).then(() =>
            Promise.reject(new Error('connection reset'))
          );
        },
      });

      await expect(client.request({ method: 'POST', path: 'charge', json: { amount: 1 } }))
        .rejects.toThrow('connection reset');
      expect(attempts).toBe(1);
    } finally {
      await app.stop();
    }
  });
});

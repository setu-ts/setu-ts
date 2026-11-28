import { WorkersResponse } from '../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * One `RuntimePlugin({ waitUntil })` serves both entry points that need the
 * platform's background-work sink (D12): the kernel's `ctx.defer` cleanup
 * after a response, and `CloudflarePlugin`'s own background work (an edge-cache
 * write). The "one capability, one implementation" rule, driven through both
 * under the fallback.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { cacheApiMiddleware, CloudflarePlugin } from '../../src/index.ts';
import { FakeCacheApi } from '../fakes.ts';

describe('one waitUntil for the kernel and CloudflarePlugin (D12)', () => {
  it('hands the kernel cleanup and the edge-cache write to the same RuntimePlugin waitUntil', async () => {
    const held: Promise<unknown>[] = [];
    const cache = new FakeCacheApi();
    const gate = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin({
          platform: 'cloudflare-workers',
          waitUntil: (promise) => {
            held.push(promise);
          },
        }),
        CloudflarePlugin({ env: {} }),
      ],
    });
    app.router.get('/cached', {
      middleware: [cacheApiMiddleware({ cache, ttlSeconds: 60 })],
      handler: (ctx) => ctx.response.text('edge'),
    });
    app.middleware.add((ctx, next) => {
      if (ctx.request.path !== '/early') return next();
      void next().catch(() => {});
      return ctx.response.text('early');
    });
    app.router.get('/early', async (ctx) => {
      ctx.defer?.(cleaned);
      await gate.promise;
      return ctx.response.text('late');
    });
    await app.start();
    try {
      await (await app.fetch(new Request('http://test/cached'))).text();
      expect(held).toHaveLength(1);
      await held[0];
      expect(cache.puts).toHaveLength(1);

      await (await app.fetch(new Request('http://test/early'))).text();
      expect(held).toHaveLength(2);
      gate.resolve();
      await held[1];
      expect(cleaned).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await app.stop();
    }
  });
});

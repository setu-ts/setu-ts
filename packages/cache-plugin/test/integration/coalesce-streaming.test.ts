/**
 * Streaming responses must join the in-flight decision but never be replayed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { cacheMiddleware, CachePlugin } from '../../src/index.ts';

describe('streaming cache coalescing', () => {
  it('runs each concurrent streaming request at origin and does not replay a leader stream', async () => {
    let calls = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'streaming-cache-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/stream', async (request: IRequestContext) => {
              const call = ++calls;
              // Keep the origin decision in flight so every request joins it
              // before the middleware discovers that the snapshot streams.
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
              return request.response.stream(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(`stream-${call}`));
                    controller.close();
                  },
                }),
              );
            });
          },
        },
      ],
    });
    await app.start();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.fetch(new Request('http://localhost/stream'))),
    );

    expect(calls).toBe(10);
    expect(responses.some((response) => response.headers.get('x-cache') === 'COALESCED')).toBe(
      false,
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array.from({ length: 10 }, (_, index) => `stream-${index + 1}`),
    );
    await app.stop();
  });
});

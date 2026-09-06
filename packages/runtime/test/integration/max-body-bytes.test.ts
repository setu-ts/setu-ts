/**
 * `RuntimePlugin({ maxBodyBytes })` end to end (M90a §3.4).
 *
 * The unit tests drive `mapWebRequestToFrameworkRequest` directly, which proves
 * the read is bounded but not that the OPTION reaches it. This file boots a real
 * kernel application and posts a real chunked body through `app.fetch`, so the
 * whole thread — plugin option → adapter factory → adapter → handle → mapping —
 * is exercised, and the response an operator would actually see is asserted.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { HandlerResult, IPluginContext, IRequestContext } from '@setu-ts/common';

const encoder = new TextEncoder();

/** A chunked POST: a stream body and no `Content-Length`. */
function chunkedPost(totalBytes: number, chunkBytes = 16): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(encoder.encode('X'.repeat(size)));
      sent += size;
    },
  });
  return new Request('http://localhost/upload', {
    method: 'POST',
    body,
    ...({ duplex: 'half' } as Record<string, unknown>),
  });
}

/** An app whose one route reads the body, with the cap optionally configured. */
async function boot(maxBodyBytes?: number) {
  const app = createApplication({
    plugins: [
      RuntimePlugin(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      {
        name: 'upload-route',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.middleware.add(errorHandler({ format: 'rfc9457' }), {
            name: 'errors',
            priority: 10,
          });
          ctx.router.post('/upload', {
            handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
              const bytes = await reqCtx.request.bytes();
              return reqCtx.response.json({ received: bytes.byteLength });
            },
          });
        },
      },
    ],
  });
  await app.start();
  return app;
}

describe('RuntimePlugin maxBodyBytes (X32-4)', () => {
  it('a chunked body past the cap answers 413 in the configured format', async () => {
    // The finding closed: no `Content-Length`, so `requestSizeMiddleware` has
    // nothing to read, and the cap is what refuses. `413` rather than a masked
    // `500` because `RequestBodyTooLargeError` carries a status hint.
    const app = await boot(64);
    try {
      const response = await app.fetch(chunkedPost(4_096));
      expect(response.status).toBe(413);
      expect(response.headers.get('content-type')).toContain('application/problem+json');

      const problem = await response.json() as Record<string, unknown>;
      expect(problem.status).toBe(413);
      expect(problem.title).toBe('Payload Too Large');
      expect(problem.detail).toBe('Request body exceeds the maximum of 64 bytes.');
    } finally {
      await app.stop();
    }
  });

  it('a chunked body under the cap is served', async () => {
    const app = await boot(4_096);
    try {
      const response = await app.fetch(chunkedPost(1_000));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: 1_000 });
    } finally {
      await app.stop();
    }
  });

  it('with NO cap the same oversized body is served — the released behaviour', async () => {
    // The discriminating half: an application that configures no limit runs
    // today's code, so the option's existence costs nothing.
    const app = await boot();
    try {
      const response = await app.fetch(chunkedPost(4_096));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: 4_096 });
    } finally {
      await app.stop();
    }
  });

  it('a GET carrying no body is unaffected by a tiny cap', async () => {
    const app = await boot(1);
    try {
      const response = await app.fetch(new Request('http://localhost/upload', { method: 'POST' }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: 0 });
    } finally {
      await app.stop();
    }
  });
});

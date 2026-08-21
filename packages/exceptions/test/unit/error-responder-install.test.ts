/**
 * Unit test: the responder a `errorHandler` installs answers a short-circuit
 * site's 4xx in the configured format WITHOUT masking it (plan §3.2).
 *
 * `maskInternalErrors` (default `true`) rewrites a caught non-`HttpError` that
 * resolves to status >= 500 into `Internal Server Error`. A responder-produced
 * 4xx must survive that: it carries a real `statusCode`, so it is neither
 * masked nor collapsed. This test drives a real `errorHandler` and a
 * short-circuiting site through a real kernel app, asserting the 400 is not
 * masked, that the content type follows the format, and that the site's
 * disclosure (`detail`) is kept verbatim (M70f F1) in BOTH formats.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { respondWithError } from '@setu-ts/common';
import type { IRequestContext } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';

/**
 * Builds a started app with `errorHandler` (masking on) and a short-circuiting
 * site at `/short` that writes a 400 through the responder and never calls
 * `next()`.
 */
async function appWith(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
  const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
  app.middleware.add(errorHandler({ format, maskInternalErrors: true, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.middleware.add(
    async (ctx: IRequestContext, next: () => Promise<void>) => {
      if (ctx.request.path === '/short') {
        // The site's (non-)disclosure decision: a 400 with a disclosure.
        respondWithError(ctx, {
          status: 400,
          title: 'Bad Request',
          detail: 'the site disclosure',
        });
        return;
      }
      await next();
    },
    { priority: 100, name: 'short-circuit' },
  );
  app.router.get('/short', (ctx) => ctx.response.text('ok'));
  await app.start();
  return app;
}

describe('the installed responder does not mask a short-circuit 4xx', () => {
  it('answers a 400 (not a masked 500) under rfc9457 with problem+json', async () => {
    const app = await appWith('rfc9457');
    try {
      const res = await app.fetch(new Request('http://test.local/short'));
      // Not masked: a 4xx keeps its status and title, not `Internal Server Error`.
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.title).toBe('Bad Request');
      expect(body.status).toBe(400);
      // The site's disclosure is kept verbatim (F1).
      expect(body.detail).toBe('the site disclosure');
    } finally {
      await app.stop();
    }
  });

  it('answers a 400 (not a masked 500) under default with application/json', async () => {
    const app = await appWith('default');
    try {
      const res = await app.fetch(new Request('http://test.local/short'));
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toBe('Bad Request');
      // The site's disclosure is kept verbatim in the default format too (F1).
      expect(body.details).toEqual({ detail: 'the site disclosure' });
    } finally {
      await app.stop();
    }
  });
});

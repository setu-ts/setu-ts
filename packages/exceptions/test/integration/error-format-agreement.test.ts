/**
 * Integration test: the X9-6 format agreement.
 *
 * The kernel's unmatched-route `404` terminal writes its body through the
 * responder seam, not through a thrown `HttpError`. Before M70f it answered
 * `{ error }` JSON regardless of what the application configured, so
 * `errorHandler({ format: 'rfc9457' })` governed the routes it wrapped but not
 * the kernel's own 404.
 *
 * This test drives a real kernel application and asserts a **thrown
 * `notFound()`** (handled by `errorHandler`'s catch path) and an **unmatched
 * route** (the kernel's own 404 terminal) produce identical `type`, `title`,
 * `status`, and `content-type` — under `'default'`, `'rfc9457'`, and a custom
 * formatter function, the non-default cases the self-review checklist
 * requires. A no-`errorHandler` app pins the fallback shape.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import type { ErrorFormat, ErrorHandlerFormatter } from '../../src/formatters/error-formatter.ts';
import { notFound } from '../../src/errors/exceptions.ts';

/**
 * Builds a started app with `errorHandler` registered (outermost) and a single
 * route `/boom` that throws `notFound('User 42 does not exist')`. An unmatched
 * route drives the kernel's own 404 terminal.
 */
async function createApp(
  format: ErrorFormat | ErrorHandlerFormatter,
): Promise<IKernelApplication> {
  const app = await createTestApp({
    plugins: [RuntimePlugin()],
    autoStart: false,
  });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/boom', () => {
    throw notFound('User 42 does not exist');
  });
  await app.start();
  return app;
}

/** Drives a path and returns the problem-relevant response fields. */
async function problem(
  app: IKernelApplication,
  path: string,
): Promise<{ status: number; contentType: string | null; body: Record<string, unknown> }> {
  const response = await app.fetch(new Request(`http://test.local${path}`));
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('the kernel 404 terminal agrees with the configured error format (X9-6)', () => {
  for (const format of ['default', 'rfc9457'] as const) {
    describe(`format: '${format}'`, () => {
      it('an unmatched route and a thrown notFound() agree on type/title/status/content-type', async () => {
        const app = await createApp(format);
        try {
          const terminal = await problem(app, '/no-such-route');
          const thrown = await problem(app, '/boom');

          expect(terminal.status).toBe(404);
          expect(terminal.contentType).toBe(thrown.contentType);
          expect(terminal.body.type).toBe(thrown.body.type);
          expect(terminal.body.title).toBe(thrown.body.title);
          expect(terminal.body.status).toBe(thrown.body.status);
        } finally {
          await app.stop();
        }
      });
    });
  }

  describe('format: a custom formatter function', () => {
    // A formatter that stamps a recognisable `marker` — proves the kernel's
    // own 404 terminal runs the application's formatter, not a hardcoded shape.
    const custom: ErrorHandlerFormatter = (error, ctx) => ({
      marker: 'custom',
      name: error.name,
      title: 'Custom',
      detail: error.message,
      ...(ctx !== undefined && { instance: ctx.request.path }),
    });

    it('the unmatched route and a thrown notFound() both carry the marker', async () => {
      const app = await createApp(custom);
      try {
        const terminal = await problem(app, '/no-such-route');
        const thrown = await problem(app, '/boom');

        expect(terminal.body.marker).toBe('custom');
        expect(thrown.body.marker).toBe('custom');
        expect(terminal.contentType).toBe(thrown.contentType);
      } finally {
        await app.stop();
      }
    });
  });

  describe('no errorHandler registered', () => {
    it('the kernel 404 terminal falls back to { error }', async () => {
      const app = await createTestApp({
        plugins: [RuntimePlugin()],
        autoStart: false,
      });
      await app.start();
      try {
        const terminal = await problem(app, '/no-such-route');
        expect(terminal.status).toBe(404);
        // No responder published → the bare fallback shape, not Problem
        // Details and not a media type the app never asked for.
        expect(terminal.body).toEqual({ error: 'Not Found' });
      } finally {
        await app.stop();
      }
    });
  });
});

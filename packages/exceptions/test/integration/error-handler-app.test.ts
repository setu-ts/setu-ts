/**
 * Integration test: the error handler inside a real kernel application.
 *
 * The unit tests drive the middleware against a fake context. This one drives
 * it through `createApplication` + the compiled middleware pipeline and reads
 * the response with `app.fetch`, because `inject()` exposes no response headers
 * and the `application/problem+json` media type is half of what RFC 9457
 * conformance means.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

import { withHttpStatusHint } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import type { ErrorHandlerOptions } from '../../src/middleware/error-handler.ts';
import { internalServerError, notFound, validationError } from '../../src/errors/exceptions.ts';
import type { ErrorFormat } from '../../src/formatters/error-formatter.ts';

/**
 * Builds a started app whose single route throws, with the error handler
 * registered as the outermost middleware.
 *
 * `autoStart: false` is required: `start()` compiles the pipeline, after which
 * `middleware.add` throws.
 */
async function createErroringApp(
  format: ErrorFormat,
  thrown: Error,
  extra?: Omit<ErrorHandlerOptions, 'format' | 'logErrors'>,
): Promise<IKernelApplication> {
  const app = await createTestApp({
    plugins: [RuntimePlugin()],
    autoStart: false,
  });

  app.middleware.add(errorHandler({ format, logErrors: false, ...extra }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/boom', () => {
    throw thrown;
  });

  await app.start();
  return app;
}

/** Drives `GET /boom` and returns the parsed body plus the content type. */
async function fetchProblem(
  app: IKernelApplication,
): Promise<{ status: number; contentType: string | null; body: Record<string, unknown> }> {
  const response = await app.fetch(new Request('http://test.local/boom'));
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('errorHandler in a kernel application', () => {
  describe("format: 'rfc9457'", () => {
    it('serves an about:blank Problem Details body as problem+json', async () => {
      const app = await createErroringApp('rfc9457', notFound('User 42 does not exist'));
      try {
        const { status, contentType, body } = await fetchProblem(app);

        expect(status).toBe(404);
        expect(contentType).toBe('application/problem+json');

        // Field-by-field against the documented RFC 9457 shape: every required
        // member present, and `message` — which Problem Details does not
        // define — absent.
        expect(body).toEqual({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'User 42 does not exist',
          instance: '/boom',
        });
        expect('message' in body).toBe(false);
      } finally {
        await app.stop();
      }
    });

    it('carries the validation problem type and errors extension for a 422', async () => {
      const thrown = validationError([
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
      ]);
      const app = await createErroringApp('rfc9457', thrown);
      try {
        const { status, contentType, body } = await fetchProblem(app);

        expect(status).toBe(422);
        expect(contentType).toBe('application/problem+json');
        expect(body.type).toBe('https://setu-ts.dev/errors/validation');
        expect(body.title).toBe('Unprocessable Entity');
        expect(body.errors).toEqual([
          { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        ]);
      } finally {
        await app.stop();
      }
    });
  });

  describe('maskInternalErrors (X12-3)', () => {
    // A real driver-shaped error — the message carries SQL and bound values.
    const driverError = new Error(
      `P2002: Unique constraint failed on the fields (email) \n` +
        `SQL: INSERT INTO "User" ("email") VALUES ('alice@example.com')`,
    );

    it('masks a driver-shaped 500 while retaining application/problem+json', async () => {
      const app = await createErroringApp('rfc9457', driverError);
      try {
        const { status, contentType, body } = await fetchProblem(app);

        expect(status).toBe(500);
        // The media type is half of RFC 9457 conformance and must survive
        // masking — the masked body is still a Problem Details body.
        expect(contentType).toBe('application/problem+json');

        // The raw message (SQL + the bound value) must be absent from the
        // body; the detail is the status title.
        expect(body.detail).toBe('Internal Server Error');
        expect(body.title).toBe('Internal Server Error');
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain('INSERT INTO');
        expect(serialized).not.toContain('alice@example.com');
      } finally {
        await app.stop();
      }
    });

    it('does not mask a deliberately thrown HttpError through the real pipeline', async () => {
      const app = await createErroringApp(
        'rfc9457',
        internalServerError('Payment gateway timed out'),
      );
      try {
        const { body } = await fetchProblem(app);
        expect(body.detail).toBe('Payment gateway timed out');
      } finally {
        await app.stop();
      }
    });
  });

  describe("deprecated format: 'rfc7807'", () => {
    it('still serves the status-derived type through the real pipeline', async () => {
      const app = await createErroringApp('rfc7807', notFound('gone'));
      try {
        const { contentType, body } = await fetchProblem(app);

        expect(contentType).toBe('application/problem+json');
        expect(body.type).toBe('https://setu-ts.dev/errors/404');
      } finally {
        await app.stop();
      }
    });
  });

  describe("format: 'default'", () => {
    it('serves the framework error shape as application/json', async () => {
      const app = await createErroringApp('default', notFound('gone'));
      try {
        const { contentType, body } = await fetchProblem(app);

        expect(contentType).toBe('application/json; charset=utf-8');
        expect(body).toEqual({ statusCode: 404, message: 'gone' });
      } finally {
        await app.stop();
      }
    });
  });
});

describe('errorHandler — a status hint the platform cannot serve', () => {
  // The hint's `status` is typed `number`, and the brand key is `Symbol.for`,
  // so the value reaching `errorHandler` comes from another package and may be
  // anything a `number` can hold. A status outside [200, 599] — or a
  // non-integer like `NaN`, which a mis-derived value collapses to — makes the
  // web `Response` constructor throw, so the ERROR HANDLER ITSELF becomes the
  // fault on the real serve path.
  //
  // Driven with `app.fetch`, never `inject()`, and that is the whole point:
  // `inject()` builds no native `Response`, so it reported `999` and `null`
  // quite happily while `app.fetch` threw `RangeError`. A unit test against a
  // fake context cannot see this class at all.
  // Two families: statuses the platform cannot serve at all, and statuses it
  // CAN serve but which an error must never carry — a hint says how an error
  // is answered, and an error is never a success or a redirect.
  const rejected = [
    999,
    0,
    -1,
    400.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    200, // serveable, but a success
    302, // serveable, but a redirect
    399, // the boundary, one below the floor
    600, // the boundary, one above the ceiling
  ];

  for (const status of rejected) {
    it(`falls back to the masked 500 for a hint carrying status ${String(status)}`, async () => {
      const app = await createErroringApp(
        'default',
        withHttpStatusHint(new Error('the full diagnostic'), {
          status,
          title: 'Not Implemented',
          detail: 'D',
        }),
      );

      const response = await app.fetch(new Request('http://test.local/boom'));

      // Treated as ABSENT — the documented rule for a non-conforming brand —
      // so the error takes the ordinary masked path rather than crashing.
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        statusCode: 500,
        message: 'Internal Server Error',
      });

      await app.stop();
    });
  }

  for (const status of [400, 501, 599]) {
    it(`serves a hint carrying the in-range status ${status}`, async () => {
      // The control at both boundaries: the guard must reject only what it
      // means to, not disable the feature.
      const app = await createErroringApp(
        'default',
        withHttpStatusHint(new Error('the full diagnostic'), {
          status,
          title: 'Refused',
          detail: 'D',
        }),
      );

      const response = await app.fetch(new Request('http://test.local/boom'));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        statusCode: status,
        message: 'Refused',
        details: { detail: 'D' },
      });

      await app.stop();
    });
  }
});

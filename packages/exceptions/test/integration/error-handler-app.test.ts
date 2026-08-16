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

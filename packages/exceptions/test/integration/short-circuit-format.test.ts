/**
 * Integration test: one app registering every converted first-party
 * short-circuit site answers each rejection in the configured format, keeping
 * the site's status, title, and disclosure verbatim (plan §3.5, X4-8).
 *
 * Sites covered: the tenant `400`, the flag-guard `404`, the auth `401`, the
 * upload `400` (too many files), the request-size `413`, and the form-CSRF
 * `403`. Each is asserted under `'rfc9457'` and `'default'`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { createFlagGuard, FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';
import { requireAuth } from '@setu-ts/auth-plugin';
import { createUploadMiddleware } from '@setu-ts/storage-plugin';
import { csrfMiddleware, requestSizeMiddleware } from '@setu-ts/http-security-plugin';
import { csrfFormMiddleware } from '@setu-ts/session-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, ISession } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';

const TENANT = { 'x-tenant-id': 'acme' };

const BOUNDARY = '----setu-x48-boundary';

/**
 * A well-formed multipart body posting TWO files — one over the
 * `maxFiles: 1` the upload site is registered with below. Since M94b a
 * boundary-less multipart content-type is classified as not-a-form and
 * passes through, so the `400` site is driven the way a real refusal fires.
 */
const TOO_MANY_FILES = `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
  'Content-Type: text/plain\r\n\r\nhello\r\n' +
  `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="file"; filename="b.txt"\r\n' +
  'Content-Type: text/plain\r\n\r\nhello\r\n' +
  `--${BOUNDARY}--\r\n`;
const MULTIPART_HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

/**
 * A minimal `ISessionService` whose session carries no CSRF token.
 *
 * `csrfFormMiddleware` reaches its `403` only when a session RESOLVES and holds
 * no token; with no `CAPABILITIES.SESSION` provider at all, `getSession` throws
 * and the site answers `500`. Faithful for the case driven here — every reader
 * is `readCsrfToken`, which asks for one key and accepts `undefined`.
 */
function sessionStubPlugin(): IPlugin {
  const session: ISession = {
    id: 'stub',
    isNew: true,
    get: () => undefined,
    set: () => {},
    has: () => false,
    delete: () => false,
    clear: () => {},
    regenerate: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    toJSON: () => ({}),
  };
  return {
    name: 'session-stub',
    version: '0.0.0',
    provides: [CAPABILITIES.SESSION],
    register(ctx) {
      ctx.services.register(CAPABILITIES.SESSION, { from: () => session });
    },
  };
}

/**
 * Builds a started app registering every converted site behind its own path,
 * with `errorHandler` at the configured format.
 */
async function allSitesApp(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
  const app = await createTestApp({
    plugins: [
      RuntimePlugin(),
      sessionStubPlugin(),
      MultiTenancyPlugin({ resolver: 'header', required: true }),
      FeatureFlagsPlugin({
        provider: 'memory',
        options: { flags: { 'off-flag': { enabled: false } } },
      }),
    ],
    autoStart: false,
  });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  // Path-scoped sites so one request drives exactly one rejection.
  app.middleware.add(
    (ctx, next) =>
      ctx.request.path === '/flagged' ? createFlagGuard('off-flag')(ctx, next) : next(),
    { priority: 100, name: 'flag-guard' },
  );
  app.middleware.add(
    (ctx, next) =>
      ctx.request.path === '/size' ? requestSizeMiddleware({ maxBodySize: 10 })(ctx, next) : next(),
    { priority: 110, name: 'request-size' },
  );
  app.middleware.add(
    (ctx, next) => ctx.request.path === '/csrf' ? csrfMiddleware({})(ctx, next) : next(),
    { priority: 120, name: 'csrf' },
  );
  app.middleware.add(
    (ctx, next) => ctx.request.path === '/form-csrf' ? csrfFormMiddleware()(ctx, next) : next(),
    { priority: 130, name: 'form-csrf' },
  );
  app.middleware.add(
    (ctx, next) =>
      ctx.request.path === '/upload' ? createUploadMiddleware({ maxFiles: 1 })(ctx, next) : next(),
    { priority: 140, name: 'upload' },
  );
  app.middleware.add(
    (ctx, next) => (ctx.request.path === '/auth' ? requireAuth()(ctx, next) : next()),
    { priority: 150, name: 'auth-guard' },
  );
  for (
    const path of [
      '/flagged',
      '/size',
      '/csrf',
      '/form-csrf',
      '/upload',
      '/auth',
      '/tenant-protected',
    ]
  ) {
    app.router.get(path, (ctx) => ctx.response.text('ok'));
  }
  app.router.post('/upload', (ctx) => ctx.response.text('ok'));
  await app.start();
  return app;
}

/** Drives a path and returns the status, content type, and JSON body. */
async function drive(
  app: IKernelApplication,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; contentType: string | null; body: Record<string, unknown> }> {
  const res = await app.fetch(new Request(`http://test.local${path}`, init));
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe('every converted short-circuit site answers in the configured format (X4-8)', () => {
  it('keeps each site status/title/disclosure verbatim under rfc9457', async () => {
    const app = await allSitesApp('rfc9457');
    try {
      const tenant = await drive(app, '/tenant-protected');
      expect(tenant.status).toBe(400);
      expect(tenant.contentType).toBe('application/problem+json');
      expect(tenant.body.title).toBe('Bad Request');
      expect(tenant.body.detail).toBe('No tenant could be resolved for this request');

      const flag = await drive(app, '/flagged', { headers: TENANT });
      expect(flag.status).toBe(404);
      expect(flag.body.title).toBe('Not Found');

      const size = await drive(app, '/size', {
        headers: { ...TENANT, 'content-length': '100' },
      });
      expect(size.status).toBe(413);
      expect(size.contentType).toBe('application/problem+json');
      // The title is the canonical status title from the shared source of
      // truth (`STATUS_TITLES`), and the site's disclosure is kept verbatim in
      // the configured format (F1).
      expect(size.body.title).toBe('Payload Too Large');
      expect(String(size.body.detail)).toContain('exceeds the maximum allowed size');

      const csrf = await drive(app, '/csrf', {
        method: 'POST',
        headers: { ...TENANT, origin: 'https://evil.example' },
      });
      expect(csrf.status).toBe(403);
      expect(csrf.body.title).toBe('Forbidden');

      // The session form-CSRF site — registered above, and previously driven by
      // neither test despite this suite's "every converted site" contract
      // (code review). A POST with no session carries no synchronizer token.
      const formCsrf = await drive(app, '/form-csrf', {
        method: 'POST',
        headers: { ...TENANT },
      });
      expect(formCsrf.status).toBe(403);
      expect(formCsrf.contentType).toBe('application/problem+json');
      expect(formCsrf.body.title).toBe('Forbidden');
      expect(formCsrf.body.detail).toBe('CSRF token validation failed');

      const auth = await drive(app, '/auth', { headers: TENANT });
      expect(auth.status).toBe(401);
      expect(auth.body.title).toBe('Unauthorized');
      // The guard's disclosure survives in the configured format (F1).
      expect(auth.body.detail).toBe('Authentication required');

      const upload = await drive(app, '/upload', {
        method: 'POST',
        headers: { ...TENANT, ...MULTIPART_HEADERS },
        body: TOO_MANY_FILES,
      });
      expect(upload.status).toBe(400);
      expect(upload.contentType).toBe('application/problem+json');
      // Canonical status title (STATUS_TITLES), site disclosure verbatim (F1).
      expect(upload.body.title).toBe('Bad Request');
      expect(upload.body.detail).toBe('Maximum 1 file(s) allowed');
    } finally {
      await app.stop();
    }
  });

  it('keeps each site status/title/disclosure verbatim under default', async () => {
    const app = await allSitesApp('default');
    try {
      const tenant = await drive(app, '/tenant-protected');
      expect(tenant.status).toBe(400);
      expect(tenant.contentType).toBe('application/json; charset=utf-8');
      expect(tenant.body.message).toBe('Tenant Required');
      // The site's disclosure survives in the default format too (F1).
      expect(tenant.body.details).toEqual({
        detail: 'No tenant could be resolved for this request',
      });

      const flag = await drive(app, '/flagged', { headers: TENANT });
      expect(flag.status).toBe(404);
      expect(flag.body.message).toBe('Not Found');

      // The three sites the default-format test previously omitted, so a
      // formatter regression on any of them passed this suite (code review).
      const size = await drive(app, '/size', {
        headers: { ...TENANT, 'content-length': '100' },
      });
      expect(size.status).toBe(413);
      expect(size.contentType).toBe('application/json; charset=utf-8');
      expect(size.body.message).toBe('Payload Too Large');
      expect(String((size.body.details as Record<string, unknown>).detail))
        .toContain('exceeds the maximum allowed size');

      const csrf = await drive(app, '/csrf', {
        method: 'POST',
        headers: { ...TENANT, origin: 'https://evil.example' },
      });
      expect(csrf.status).toBe(403);
      expect(csrf.body.message).toBe('Forbidden');
      expect(csrf.body.details).toEqual({ detail: 'Cross-origin request not allowed' });

      const formCsrf = await drive(app, '/form-csrf', {
        method: 'POST',
        headers: { ...TENANT },
      });
      expect(formCsrf.status).toBe(403);
      expect(formCsrf.body.message).toBe('Forbidden');
      expect(formCsrf.body.details).toEqual({ detail: 'CSRF token validation failed' });

      const auth = await drive(app, '/auth', { headers: TENANT });
      expect(auth.status).toBe(401);
      expect(auth.body.message).toBe('Unauthorized');
      expect(auth.body.details).toEqual({ detail: 'Authentication required' });

      const upload = await drive(app, '/upload', {
        method: 'POST',
        headers: { ...TENANT, ...MULTIPART_HEADERS },
        body: TOO_MANY_FILES,
      });
      expect(upload.status).toBe(400);
      expect(upload.contentType).toBe('application/json; charset=utf-8');
      expect(upload.body.message).toBe('Too many files');
      expect(upload.body.details).toEqual({ detail: 'Maximum 1 file(s) allowed' });
    } finally {
      await app.stop();
    }
  });
});

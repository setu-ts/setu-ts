/**
 * Integration test: one app registering every converted first-party
 * short-circuit site answers each rejection in the configured format, keeping
 * the site's status, title, and disclosure verbatim (plan §3.5, X4-8).
 *
 * Sites covered: the tenant `400`, the flag-guard `404`, the auth `401`, the
 * upload `400` (malformed), the request-size `413`, and the form-CSRF `403`.
 * Each is asserted under `'rfc9457'` and `'default'`.
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

import { errorHandler } from '../../src/middleware/error-handler.ts';

const TENANT = { 'x-tenant-id': 'acme' };

/** A genuinely malformed multipart body (no boundary in the content type). */
const MALFORMED = 'not a real multipart body';
const MALFORMED_HEADERS = { 'content-type': 'multipart/form-data' };

/**
 * Builds a started app registering every converted site behind its own path,
 * with `errorHandler` at the configured format.
 */
async function allSitesApp(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
  const app = await createTestApp({
    plugins: [
      RuntimePlugin(),
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
    (ctx, next) => ctx.request.path === '/upload' ? createUploadMiddleware()(ctx, next) : next(),
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

      const auth = await drive(app, '/auth', { headers: TENANT });
      expect(auth.status).toBe(401);
      expect(auth.body.title).toBe('Unauthorized');
      // The guard's disclosure survives in the configured format (F1).
      expect(auth.body.detail).toBe('Authentication required');

      const upload = await drive(app, '/upload', {
        method: 'POST',
        headers: { ...TENANT, ...MALFORMED_HEADERS },
        body: MALFORMED,
      });
      expect(upload.status).toBe(400);
      expect(upload.body.title).toBe('Bad Request');
      expect(upload.body.detail).toBe('Failed to parse multipart body');
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

      const auth = await drive(app, '/auth', { headers: TENANT });
      expect(auth.status).toBe(401);
      expect(auth.body.message).toBe('Unauthorized');
      expect(auth.body.details).toEqual({ detail: 'Authentication required' });

      const upload = await drive(app, '/upload', {
        method: 'POST',
        headers: { ...TENANT, ...MALFORMED_HEADERS },
        body: MALFORMED,
      });
      expect(upload.status).toBe(400);
      expect(upload.body.message).toBe('Bad Request');
      expect(upload.body.details).toEqual({ detail: 'Failed to parse multipart body' });
    } finally {
      await app.stop();
    }
  });
});

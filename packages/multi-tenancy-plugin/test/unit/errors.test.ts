/**
 * TenantNotResolvedError — basic verification.
 */
import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import {
  REGISTRY_UNAVAILABLE_DETAIL,
  REGISTRY_UNAVAILABLE_TITLE,
  TenantDataStoreNotReadyError,
  TenantNotResolvedError,
  TenantRegistryUnavailableError,
} from '../../src/errors.ts';

describe('errors', () => {
  it('TenantNotResolvedError is an Error', () => {
    const err = new TenantNotResolvedError();
    expect(err instanceof Error).toBeTruthy();
    expect(err instanceof TenantNotResolvedError).toBeTruthy();
    expect(err.name).toEqual('TenantNotResolvedError');
  });

  it('TenantNotResolvedError carries a message', () => {
    const msg = 'Custom message';
    const err = new TenantNotResolvedError(msg);
    expect(err.message).toEqual(msg);
  });

  it('default message when none provided', () => {
    const err = new TenantNotResolvedError();
    expect(err.message).toEqual('Tenant not resolved');
  });

  it('TenantDataStoreNotReadyError is an Error (M101c, V8-8)', () => {
    const err = new TenantDataStoreNotReadyError();
    expect(err instanceof Error).toBeTruthy();
    expect(err instanceof TenantDataStoreNotReadyError).toBeTruthy();
    expect(err.name).toEqual('TenantDataStoreNotReadyError');
    // The default message names the `onInit` phase and the factory arm, so a
    // `register()`-time repository call fails loudly rather than per request.
    expect(err.message).toContain('onInit');
  });

  it('TenantDataStoreNotReadyError carries a custom message', () => {
    const err = new TenantDataStoreNotReadyError('custom');
    expect(err.message).toEqual('custom');
  });

  it('TenantRegistryUnavailableError: name, message, cause (M127 §3.9)', () => {
    const cause = new Error('db down');
    const err = new TenantRegistryUnavailableError('lookup threw', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TenantRegistryUnavailableError');
    expect(err.message).toBe('lookup threw');
    expect(err.cause).toBe(cause);
    expect(new TenantRegistryUnavailableError().message).toBe(
      'The tenant registry could not be consulted',
    );
  });

  it("TenantRegistryUnavailableError carries a 503 hint equal to the middleware's title and detail", () => {
    expect(httpStatusHintOf(new TenantRegistryUnavailableError())).toEqual({
      status: 503,
      title: REGISTRY_UNAVAILABLE_TITLE,
      detail: REGISTRY_UNAVAILABLE_DETAIL,
    });
    expect(REGISTRY_UNAVAILABLE_TITLE).toBe('Tenant Registry Unavailable');
    expect(REGISTRY_UNAVAILABLE_DETAIL).toBe('The tenant could not be checked; try again later');
  });

  it('a handler that lets it escape answers 503 through errorHandler, not a masked 500', async () => {
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 1, name: 'errors' });
    app.router.get('/job', () => {
      throw new TenantRegistryUnavailableError('internal reason', { cause: new Error('x') });
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/job' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: REGISTRY_UNAVAILABLE_DETAIL,
      instance: '/job',
    });
    expect(res.body).not.toContain('internal reason');
    await app.stop();
  });

  it.each(['default', 'rfc9457'] as const)(
    "under format %s the escaped error's body equals the middleware's own 503 body",
    async (format) => {
      const { MultiTenancyPlugin } = await import('../../src/index.ts');
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MultiTenancyPlugin({
            resolver: 'header',
            exclude: ['/job'],
            tenants: { lookup: () => Promise.reject(new Error('down')) },
          }),
        ],
      });
      app.middleware.add(errorHandler({ format }), { priority: 1, name: 'errors' });
      app.router.get('/job', () => {
        throw new TenantRegistryUnavailableError('internal reason');
      });
      app.router.get('/mw', (ctx) => ctx.response.json({ ok: true }));
      await app.start();
      const escaped = await app.inject({ method: 'GET', url: 'http://localhost/job' });
      const middleware = await app.inject({
        method: 'GET',
        url: 'http://localhost/mw',
        headers: { 'x-tenant-id': 'acme' },
      });
      expect(escaped.statusCode).toBe(503);
      expect(middleware.statusCode).toBe(503);
      const strip = (body: string | null) => {
        const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
        delete parsed.instance;
        return parsed;
      };
      expect(strip(escaped.body)).toEqual(strip(middleware.body));
      expect(escaped.body).not.toContain('internal reason');
      expect(escaped.body).toContain(REGISTRY_UNAVAILABLE_DETAIL);
      await app.stop();
    },
  );
});

/**
 * MultiTenancyService tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import { TenantNotResolvedError } from '../../src/errors.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';

describe('multi tenancy service', () => {
  it('MultiTenancyService — getCurrentTenant returns tenant', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    const ctx = createFakeContext({
      tenant: { id: 'acme' },
    });
    expect(service.getCurrentTenant(ctx)?.id).toEqual('acme');
  });

  it('MultiTenancyService — getCurrentTenant returns undefined when no tenant', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    const ctx = createFakeContext();
    expect(service.getCurrentTenant(ctx)).toEqual(undefined);
  });

  it('MultiTenancyService — getRepository throws without tenant', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    const ctx = createFakeContext();
    expect(() => service.getRepository<typeof ctx>(ctx, 'User')).toThrow(TenantNotResolvedError);
  });

  it('MultiTenancyService — getRepository returns repo with tenant', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    const tenant = { id: 'acme' };
    const fakeRequest = {
      method: 'GET',
      url: 'https://example.com/',
      path: '/',
      headers: new Headers(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    };
    const ctx = {
      ...createFakeContext(),
      request: { ...fakeRequest, tenant },
    } as unknown as import('@hono-enterprise/common').IRequestContext;
    const repo = service.getRepository<unknown, string>(ctx, 'User');
    // Verify it satisfies ITenantRepository surface
    expect(typeof repo.findAll === 'function').toBeTruthy();
    expect(typeof repo.findById === 'function').toBeTruthy();
    expect(typeof repo.find === 'function').toBeTruthy();
    expect(typeof repo.create === 'function').toBeTruthy();
    expect(typeof repo.update === 'function').toBeTruthy();
    expect(typeof repo.delete === 'function').toBeTruthy();
  });

  it('MultiTenancyService — prefixCacheKey default separator', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    expect(service.prefixCacheKey('t1', 'k')).toEqual('t1:k');
  });

  it('MultiTenancyService — prefixCacheKey uses configured separator', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store, separator: '/' });
    expect(service.prefixCacheKey('t1', 'k')).toEqual('t1/k');
  });

  it('MultiTenancyService — prefixCacheKey with dash separator', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store, separator: '-' });
    expect(service.prefixCacheKey('t1', 'k')).toEqual('t1-k');
  });

  it('MultiTenancyService — getCurrentTenant returns tenant from ctx.request.tenant', () => {
    const store = {} as unknown as ITenantDataStore;
    const service = new MultiTenancyService({ store });
    // Create a context where request.tenant is set (simulating middleware has run).
    const fakeRequest = {
      method: 'GET' as const,
      url: 'https://example.com/' as string,
      path: '/' as string,
      headers: new Headers(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    };
    const ctx = {
      id: 'test-id',
      request: { ...fakeRequest, tenant: { id: 'resolved-tenant' } },
      response: {} as import('@hono-enterprise/common').IResponse,
      services: new Map(),
      params: {},
      query: {},
      state: new Map(),
      startTime: Date.now(),
      signal: undefined as AbortSignal | undefined,
    } as unknown as import('@hono-enterprise/common').IRequestContext;
    expect(service.getCurrentTenant(ctx)?.id).toEqual('resolved-tenant');
  });
});

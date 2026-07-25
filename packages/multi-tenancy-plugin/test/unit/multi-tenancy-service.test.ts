/**
 * MultiTenancyService tests.
 */
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.19';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import { TenantNotResolvedError } from '../../src/errors.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';

Deno.test('MultiTenancyService — getCurrentTenant returns tenant', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store });
  const ctx = createFakeContext({
    tenant: { id: 'acme' },
  });
  assertEquals(service.getCurrentTenant(ctx)?.id, 'acme');
});

Deno.test('MultiTenancyService — getCurrentTenant returns undefined when no tenant', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store });
  const ctx = createFakeContext();
  assertEquals(service.getCurrentTenant(ctx), undefined);
});

Deno.test('MultiTenancyService — getRepository throws without tenant', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store });
  const ctx = createFakeContext();
  assertThrows(
    () => service.getRepository<typeof ctx>(ctx, 'User'),
    TenantNotResolvedError,
  );
});

Deno.test('MultiTenancyService — getRepository returns repo with tenant', () => {
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
  assert(typeof repo.findAll === 'function');
  assert(typeof repo.findById === 'function');
  assert(typeof repo.find === 'function');
  assert(typeof repo.create === 'function');
  assert(typeof repo.update === 'function');
  assert(typeof repo.delete === 'function');
});

Deno.test('MultiTenancyService — prefixCacheKey default separator', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store });
  assertEquals(service.prefixCacheKey('t1', 'k'), 't1:k');
});

Deno.test('MultiTenancyService — prefixCacheKey custom separator', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store });
  assertEquals(service.prefixCacheKey('t1', 'k', '/'), 't1/k');
});

Deno.test('MultiTenancyService — constructor separator', () => {
  const store = {} as unknown as ITenantDataStore;
  const service = new MultiTenancyService({ store, separator: '-' });
  assertEquals(service.prefixCacheKey('t1', 'k'), 't1-k');
});

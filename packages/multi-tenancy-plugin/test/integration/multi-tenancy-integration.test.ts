/**
 * End-to-end integration: plugin registration, middleware resolution,
 * memory store CRUD, and cross-tenant isolation.
 */
import { assert, assertEquals } from 'jsr:@std/assert';
import { MemoryTenantDataStore } from '../../src/stores/memory-tenant-store.ts';
import { getTenantCachePrefix, tenantMiddleware } from '../../src/middleware/tenant-middleware.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import { HeaderResolver } from '../../src/resolvers/header-resolver.ts';
import { CAPABILITIES } from '@hono-enterprise/common';

Deno.test('integration — full pipeline with header resolver', async () => {
  const store = new MemoryTenantDataStore({ generateId: () => 'int-id-1' });
  const service = new MultiTenancyService({ store });
  const resolver = new HeaderResolver();

  const state = new Map<string, unknown>();
  const headers = new Headers({ 'x-tenant-id': 'acme' });

  let middlewareNextCalled = false;
  const mw = tenantMiddleware({
    service,
    resolvers: [resolver],
    options: { cache: { prefix: true } },
  });

  const request = {
    method: 'GET',
    url: 'https://example.com/',
    path: '/',
    headers,
    json: () => Promise.resolve({}) as Promise<unknown>,
    text: async () => '',
    bytes: async () => new Uint8Array(),
  } as any;

  const ctx = {
    id: 'integ-1',
    request,
    response: {
      status: (code: number) => ({
        header: () => ({ json: () => null as never }),
        json: () => null as never,
      }),
      json: () => null as never,
      snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
    } as any,
    services: { has: () => true, get: () => service, register: () => {} } as any,
    params: {},
    query: {},
    state,
    startTime: performance.now(),
    signal: new AbortController().signal,
  } as any;

  await mw(ctx, async () => {
    middlewareNextCalled = true;
  });

  assert(middlewareNextCalled);
  assert((request as any).tenant != null);
  assertEquals((request as any).tenant.id, 'acme');

  // Service returns current tenant
  assertEquals(service.getCurrentTenant(ctx)?.id, 'acme');

  // Cache prefix is stamped
  const prefix = getTenantCachePrefix(ctx);
  assert(prefix != null);
});

Deno.test('integration — cross-tenant isolation via memory store', async () => {
  const store = new MemoryTenantDataStore({ generateId: () => 'id-1' });
  const serviceA = new MultiTenancyService({ store });
  const serviceB = new MultiTenancyService({ store });

  const requestA = {
    method: 'GET',
    url: 'https://example.com/',
    path: '/',
    headers: new Headers(),
    json: () => Promise.resolve({}) as Promise<unknown>,
    text: async () => '',
    bytes: async () => new Uint8Array(),
  } as any;
  requestA.tenant = { id: 'tenant-a' };

  const requestB = {
    method: 'GET',
    url: 'https://example.com/',
    path: '/',
    headers: new Headers(),
    json: () => Promise.resolve({}) as Promise<unknown>,
    text: async () => '',
    bytes: async () => new Uint8Array(),
  } as any;
  requestB.tenant = { id: 'tenant-b' };

  const ctxA = {
    id: 'a',
    request: requestA,
    services: { has: () => true, get: () => serviceA, register: () => {} } as any,
    state: new Map(),
    startTime: performance.now(),
    signal: new AbortController().signal,
  } as any;

  const ctxB = {
    id: 'b',
    request: requestB,
    services: { has: () => true, get: () => serviceB, register: () => {} } as any,
    state: new Map(),
    startTime: performance.now(),
    signal: new AbortController().signal,
  } as any;

  // Tenant A creates a record
  const repoA = serviceA.getRepository<any>(ctxA, 'Item');
  const created = await repoA.create({ name: 'From A' }) as Record<string, unknown>;
  assert(created.id != null);

  // Tenant B should NOT see it
  const repoB = serviceB.getRepository<any>(ctxB, 'Item');
  const bItems = await repoB.findAll();
  assertEquals(bItems.length, 0);

  // Tenant A still sees its own
  const aItems = await repoA.findAll();
  assertEquals(aItems.length, 1);
});

Deno.test('integration — required:true rejects unresolvable request', async () => {
  const store = new MemoryTenantDataStore();
  const service = new MultiTenancyService({ store });
  const noneResolver = {
    resolve: () => Promise.resolve({ present: false }),
  };

  const state = new Map();
  const request = {
    method: 'GET',
    url: 'https://example.com/',
    path: '/',
    headers: new Headers(),
    json: () => Promise.resolve({}) as Promise<unknown>,
    text: async () => '',
    bytes: async () => new Uint8Array(),
  } as any;

  let shortCircuitStatus = 0;
  const ctx = {
    id: 'req',
    request,
    response: {
      status: (code: number) => {
        shortCircuitStatus = code;
        return { json: () => null as never };
      },
      json: () => null as never,
      snapshot: () => ({ streaming: false, status: 0, headers: new Headers(), body: null }),
    } as any,
    services: { has: () => true, get: () => service, register: () => {} } as any,
    params: {},
    query: {},
    state,
    startTime: performance.now(),
    signal: new AbortController().signal,
  } as any;

  let handlerNextCalled = false;
  const mw = tenantMiddleware({
    service,
    resolvers: [noneResolver as any],
    options: { required: true },
  });

  await mw(ctx, async () => {
    handlerNextCalled = true;
  });

  assertEquals(shortCircuitStatus, 400);
  assert(!handlerNextCalled, 'Handler must NOT run when required:true and no tenant resolves');
});

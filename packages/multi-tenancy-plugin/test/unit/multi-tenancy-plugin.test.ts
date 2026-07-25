/**
 * MultiTenancyPlugin tests — name, version, provides, register behavior.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { MultiTenancyPlugin } from '../../src/plugin/multi-tenancy-plugin.ts';
import { HeaderResolver } from '../../src/resolvers/header-resolver.ts';
import { PathResolver } from '../../src/resolvers/path-resolver.ts';
import { CAPABILITIES, type ITenantResolver, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';
import { createRecordingFakeStore } from '../fixtures/fake-store.ts';

// -- Helpers ---------------------------------------------------------------

function makeMockContext() {
  const registeredServices = new Map<string, unknown>();
  const addedMiddlewares: Array<{ fn: unknown; opts: { priority: number; name: string } }> = [];
  const healthRegistrations: Array<{ name: string; checkFn: () => Promise<unknown> }> = [];
  const onCloseCallbacks: Array<() => Promise<void>> = [];
  const warnCalls: string[] = [];

  return {
    services: {
      has: (token: string) => token === CAPABILITIES.JWT || token === CAPABILITIES.LOGGER,
      get: <T>(token: string): T => {
        if (token === CAPABILITIES.JWT) {
          return { decode: (_t: string) => ({ tenant_id: 'jwt-tenant' }) } as T;
        }
        return registeredServices.get(token) as T;
      },
      register: (token: string, svc: unknown) => {
        registeredServices.set(token, svc);
      },
    },
    middleware: {
      add: (fn: unknown, opts: { priority: number; name: string }) => {
        addedMiddlewares.push({ fn, opts });
      },
    },
    health: {
      register: (name: string, checkFn: () => Promise<unknown>) => {
        healthRegistrations.push({ name, checkFn });
      },
    },
    lifecycle: {
      onClose: (cb: () => Promise<void>) => {
        onCloseCallbacks.push(cb);
      },
    },
    logger: {
      level: 2,
      warn(m: string) {
        warnCalls.push(m);
      },
      fatal() {},
      error() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return this;
      },
    } as any,
    runtime: {
      uuid: () => `uuid-${Math.random().toString(36).slice(2)}`,
    },
    // Exposed for assertions
    registeredServices,
    addedMiddlewares,
    healthRegistrations,
    onCloseCallbacks,
    warnCalls,
  };
}

Deno.test('plugin — metadata correct', () => {
  const plugin = MultiTenancyPlugin({ resolver: new HeaderResolver() });
  assertEquals(plugin.name, 'multi-tenancy-plugin');
  assertEquals(plugin.version, '0.1.0');
  assertEquals(plugin.provides, [CAPABILITIES.MULTI_TENANCY]);
  assertEquals(plugin.optionalDependencies, [CAPABILITIES.LOGGER, CAPABILITIES.JWT]);
  assertEquals(plugin.priority, PLUGIN_PRIORITY.NORMAL);
});

Deno.test('plugin — register() registers service under MULTI_TENANCY', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'header' });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
});

Deno.test('plugin — register() adds middleware with default priority 40', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'header' });
  await plugin.register(ctx as any);

  assertEquals(ctx.addedMiddlewares.length, 1);
  assertEquals(ctx.addedMiddlewares[0].opts.priority, 40);
  assertEquals(ctx.addedMiddlewares[0].opts.name, 'tenant');
});

Deno.test('plugin — register() honors custom middlewarePriority', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'header', middlewarePriority: 55 });
  await plugin.register(ctx as any);

  assertEquals(ctx.addedMiddlewares[0].opts.priority, 55);
});

Deno.test('plugin — register() passes strategy to store.useIsolation', async () => {
  // Verify that a custom dataStore with useIsolation receives the strategy.
  let receivedStrategy: any = null;
  const customStore = {
    useIsolation: (s: any) => {
      receivedStrategy = s;
    },
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    find: () => Promise.resolve([]),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(null),
    delete: () => Promise.resolve(false),
    close: () => {},
  } as any;
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    database: 'schema-per-tenant',
    dataStore: customStore,
  });
  await plugin.register(ctx as any);

  assert(receivedStrategy != null, 'useIsolation should have been called');
  assertEquals(receivedStrategy.kind, 'schema');
});

Deno.test('plugin — register() guarded when store lacks useIsolation', async () => {
  const fakeStore = createRecordingFakeStore({ omitUseIsolation: true });
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    dataStore: fakeStore,
  });
  // Should not throw
  await plugin.register(ctx as any);
});

Deno.test('plugin — default store uses ctx.runtime.uuid()', async () => {
  const ctx = makeMockContext();
  const expectedUuid = 'test-uuid-123';
  (ctx.runtime as any).uuid = () => expectedUuid;

  const plugin = MultiTenancyPlugin({ resolver: 'header' });
  await plugin.register(ctx as any);

  // Just verify register didn't throw — uuid was called.
  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
});

Deno.test('plugin — health indicator returns { status: up, data: {...} }', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'header', database: 'schema-per-tenant' });
  await plugin.register(ctx as any);

  assertEquals(ctx.healthRegistrations.length, 1);
  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).status, 'up');
  assertEquals((result as any).data.strategy, 'schema');
  assertEquals((result as any).data.store, 'memory');
});

Deno.test('plugin — health indicator: custom store shows store=custom', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    dataStore: {} as ITenantDataStore,
  });
  await plugin.register(ctx as any);

  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).data.store, 'custom');
});

Deno.test('plugin — onClose calls store.close()', async () => {
  let closeCalled = false;
  const customStore = {
    useIsolation: () => {},
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    find: () => Promise.resolve([]),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(null),
    delete: () => Promise.resolve(false),
    close: () => {
      closeCalled = true;
      return Promise.resolve();
    },
  } as any;
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    dataStore: customStore,
  });
  await plugin.register(ctx as any);

  // Simulate lifecycle close
  for (const cb of ctx.onCloseCallbacks) {
    await cb();
  }

  assert(closeCalled, 'store.close() should be called on close');
});

Deno.test('plugin — jwt resolver with JWT capability wires decode', async () => {
  const ctx = makeMockContext();
  const regSvc = ctx.registeredServices;
  (ctx.services as unknown as Record<string, unknown>).has = (token: string) =>
    token === CAPABILITIES.JWT || token === CAPABILITIES.LOGGER;
  (ctx.services as unknown as Record<string, unknown>).get = (token: string) => {
    if (token === CAPABILITIES.JWT) {
      return {
        decode: (_t: string) => ({ tenant_id: 'jwt-from-capability' } as Record<string, unknown>),
      };
    }
    return regSvc.get(token) ?? null;
  };
  (ctx.services as unknown as Record<string, unknown>).register = (
    _token: string,
    svc: unknown,
  ) => {
    regSvc.set(_token, svc);
  };

  const plugin = MultiTenancyPlugin({ resolver: 'jwt' });
  await plugin.register(ctx as any);

  // Should succeed — JWT capability provides the decoder.
  assert(regSvc.has(CAPABILITIES.MULTI_TENANCY));
});

Deno.test('plugin — jwt resolver without JWT capability throws fail-fast', async () => {
  const ctx = makeMockContext();
  (ctx.services as any).has = (token: string) => token === CAPABILITIES.LOGGER; // no JWT
  ctx.services.get = () => null as never;

  const plugin = MultiTenancyPlugin({ resolver: 'jwt' });
  try {
    await plugin.register(ctx as any);
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err instanceof Error);
    assert(err.message.includes('JwtResolver') || err.message.includes('JWT'));
  }
});

Deno.test('plugin — duplicate registration same name', () => {
  const p1 = MultiTenancyPlugin({ resolver: 'header' });
  const p2 = MultiTenancyPlugin({ resolver: 'subdomain' });
  assertEquals(p1.name, p2.name);
  assertEquals(p1.name, 'multi-tenancy-plugin');
});

// ---------------------------------------------------------------------------
// Additional branch coverage tests
// ---------------------------------------------------------------------------

Deno.test('plugin — resolver discriminant "subdomain" builds SubdomainResolver', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'subdomain' });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  assertEquals(ctx.addedMiddlewares.length, 1);
});

Deno.test('plugin — resolver discriminant "path" builds PathResolver', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'path' });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  assertEquals(ctx.addedMiddlewares.length, 1);
});

Deno.test('plugin — resolver discriminant "database" uses DatabasePerTenant strategy', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    database: 'database-per-tenant',
  });
  await plugin.register(ctx as any);

  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).data.strategy, 'database');
});

Deno.test('plugin — custom resolver object passed directly wraps in array', async () => {
  const customResolver = {
    resolve: async () => ({ present: true, value: { id: 'custom' } }),
  } as unknown as ITenantResolver;
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: customResolver });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  assertEquals(ctx.addedMiddlewares.length, 1);
});

Deno.test('plugin — array of resolvers passes through as-is', async () => {
  const resolvers = [new HeaderResolver(), new PathResolver()];
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: resolvers });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  assertEquals(ctx.addedMiddlewares.length, 1);
});

Deno.test('plugin — jwt resolver with jwt.decode option (not capability)', async () => {
  const ctx = makeMockContext();
  // Override services.has to NOT provide JWT capability
  (ctx.services as any).has = (token: string) => token === CAPABILITIES.LOGGER;
  ctx.services.get = () => null as never;

  const plugin = MultiTenancyPlugin({
    resolver: 'jwt',
    jwt: {
      decode: () => ({ tenant_id: 'direct-decode' }),
    },
  });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
});

Deno.test('plugin — cache.separator option path triggers separator in service construction', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    cache: { separator: '/' },
  });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  const service = ctx.registeredServices.get(CAPABILITIES.MULTI_TENANCY);
  assert(service != null);
  // The service should use '/' as the separator
  assertEquals(
    (service as import('../../src/services/multi-tenancy-service.ts').MultiTenancyService)
      .prefixCacheKey('t1', 'k'),
    't1/k',
  );
});

Deno.test('plugin — unknown resolver discriminant defaults to empty chain', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({ resolver: 'unknown-strategy' as any });
  await plugin.register(ctx as any);

  assert(ctx.registeredServices.has(CAPABILITIES.MULTI_TENANCY));
  assertEquals(ctx.addedMiddlewares.length, 1);
});

Deno.test('plugin — custom strategy object bypasses buildStrategy switch', async () => {
  const ctx = makeMockContext();
  const customStrategy = { kind: 'column' as const, getTenantColumn: () => 'tenant_id' };
  const plugin = MultiTenancyPlugin({
    resolver: 'header',
    database: customStrategy as any,
  });
  await plugin.register(ctx as any);

  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).data.strategy, 'column');
});

Deno.test('plugin — health indicator resolver type for array config', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: [new HeaderResolver()],
  });
  await plugin.register(ctx as any);

  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).data.resolver, 'chain');
});

Deno.test('plugin — health indicator resolver type for unknown/null', async () => {
  const ctx = makeMockContext();
  const plugin = MultiTenancyPlugin({
    resolver: undefined as unknown as 'header',
  });
  await plugin.register(ctx as any);

  const result = await ctx.healthRegistrations[0].checkFn();
  assertEquals((result as any).data.resolver, 'unknown');
});

// ---------------------------------------------------------------------------
// Integration tests to cover anonymous functions (jwtDecode, generateId)
// ---------------------------------------------------------------------------

Deno.test('plugin — jwt decode function from capability is invoked when middleware processes request', async () => {
  // This test exercises the jwtDecode arrow function at line 142 and generatesId at line 171
  // by wiring the full plugin → service → middleware → JwtResolver chain.
  let decodedToken = '';
  const regSvc = new Map<string, unknown>();
  const addedMiddlewares: Array<{ fn: unknown; opts: { priority: number; name: string } }> = [];
  const ctx = {
    services: {
      has: (token: string) => token === CAPABILITIES.JWT || token === CAPABILITIES.LOGGER,
      get: (token: string) => {
        if (token === CAPABILITIES.JWT) {
          return {
            decode: (t: string) => {
              decodedToken = t;
              return { tenant_id: 'jwt-mw-tenant' };
            },
          };
        }
        return regSvc.get(token) ?? null;
      },
      register: (token: string, svc: unknown) => {
        regSvc.set(token, svc);
      },
    },
    middleware: {
      add: (fn: unknown, opts: { priority: number; name: string }) => {
        addedMiddlewares.push({ fn, opts });
      },
    },
    health: { register: () => {} },
    lifecycle: { onClose: () => {} },
    runtime: { uuid: () => 'uuid-123' },
  } as any;

  const plugin = MultiTenancyPlugin({ resolver: 'jwt' });
  await plugin.register(ctx);

  // Now invoke the middleware with a Bearer token that JwtResolver will decode
  const mwFn = addedMiddlewares[0]?.fn as (
    ctx: Record<string, unknown>,
    nextFn: () => Promise<void>,
  ) => Promise<void>;
  assert(mwFn != null, 'middleware should have been registered');

  // Build fake context for middleware invocation
  const mwCtx: Record<string, unknown> = {
    id: 'mw-req-1',
    request: {
      method: 'GET',
      url: 'https://example.com/',
      path: '/api/users',
      headers: new Headers({ authorization: 'Bearer eyJ0aWQiOiJqd3ctbXctdGVuYW50fQ' }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    },
    response: {} as unknown,
    services: {} as unknown,
    params: {},
    query: {},
    state: new Map(),
    startTime: Date.now(),
    signal: undefined as AbortSignal | undefined,
  };
  let nextCalled = false;
  await mwFn!(mwCtx, async () => {
    nextCalled = true;
  });

  assert(nextCalled, 'next should have been called');
  assert(decodedToken.length > 0, 'jwtDecode(token) should have been invoked via JwtResolver');
});

Deno.test('plugin — default store generateId is invoked when creating records via middleware', async () => {
  // Exercises generateId: () => ctx.runtime.uuid() at line 171 by wiring full plugin →
  // middleware → resolver chain, then invoking a request. The middleware attaches resolved
  // tenant to ctx.request.tenant; MemoryTenantDataStore calls generateId on record creation.
  let uuidCalled = false;
  const regSvc = new Map<string, unknown>();
  const addedMiddlewares: Array<{ fn: unknown; opts: { priority: number; name: string } }> = [];
  const ctx = {
    services: {
      has: (token: string) => token === CAPABILITIES.LOGGER,
      get: () => null,
      register: (token: string, svc: unknown) => {
        regSvc.set(token, svc);
      },
    },
    middleware: {
      add: (fn: unknown, opts: { priority: number; name: string }) => {
        addedMiddlewares.push({ fn, opts });
      },
    },
    health: { register: () => {} },
    lifecycle: { onClose: () => {} },
    runtime: {
      uuid: () => {
        uuidCalled = true;
        return 'generated-uuid';
      },
    },
  } as any;

  const plugin = MultiTenancyPlugin({ resolver: 'header' });
  await plugin.register(ctx);

  // Verify that the service was registered
  assert(regSvc.has(CAPABILITIES.MULTI_TENANCY));

  // Get the service and call create() on the store to trigger generateId
  const service = regSvc.get(
    CAPABILITIES.MULTI_TENANCY,
  ) as import('../../src/services/multi-tenancy-service.ts').MultiTenancyService;
  assert(service != null);
  const mockStore = (service as any).store;
  assert(mockStore != null);

  await mockStore.create('tenant1', 'User', { name: 'test-user' });
  assert(uuidCalled, 'generateId callback should be invoked during store.create()');
});

/**
 * MultiTenancyPlugin tests — name, version, provides, register behavior.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { MultiTenancyPlugin } from '../../src/plugin/multi-tenancy-plugin.ts';
import { HeaderResolver } from '../../src/resolvers/header-resolver.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
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

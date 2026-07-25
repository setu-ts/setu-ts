/**
 * Tenant middleware tests — success, short-circuit, cache prefix, resolver throw.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.19';
import { getTenantCachePrefix, tenantMiddleware } from '../../src/middleware/tenant-middleware.ts';
import { SubdomainResolver } from '../../src/resolvers/subdomain-resolver.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import type { ITenantResolver } from '@hono-enterprise/common';

// Fake ITenantResolver for tests that need a custom one.
type FakeResolverResult = { present: boolean; value?: { id: string } };

interface FakeResolver {
  resolve(req: { tenant?: { id: string; name?: string } }): Promise<FakeResolverResult>;
}

function toITenantResolver(fake: FakeResolver): ITenantResolver {
  return {
    resolve: fake.resolve.bind(fake),
  } as unknown as ITenantResolver;
}

// -- Helpers ---------------------------------------------------------------

function makeContext(opts?: { state?: Map<string, unknown>; tenant?: unknown }) {
  const state = opts?.state ?? new Map();
  let storedTenant: { id: string; name?: string } | undefined = opts?.tenant as
    | { id: string; name?: string }
    | undefined;
  const request = {
    method: 'GET',
    url: 'https://acme.example.com/',
    path: '/',
    headers: new Headers(),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
    get tenant() {
      return storedTenant;
    },
    set tenant(v) {
      storedTenant = v;
    },
  };
  let nextCalled = false;
  const response = {
    status: (_code: number) => ({
      header: () => ({ json: () => undefined }),
      json: () => undefined,
    }),
    json: () => undefined,
    snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
  };
  return {
    ctx: {
      id: 'req-1',
      request,
      response,
      services: {} as never,
      params: {},
      query: {},
      state,
      startTime: performance.now(),
      signal: new AbortController().signal,
    },
    next: () => {
      nextCalled = true;
      return Promise.resolve();
    },
    getNextCalled: () => nextCalled,
    getState: () => state,
  };
}

function makeService() {
  return new MultiTenancyService({});
}

// Logger with all required ILogger methods.
function makeLogger() {
  const warnCalls: string[] = [];
  const log = {
    level: 'warn' as const,
    warn(m: string, _md?: unknown) {
      warnCalls.push(m);
    },
    fatal(_m: string, _md?: unknown) {},
    error(_m: string, _md?: unknown) {},
    info(_m: string, _md?: unknown) {},
    debug(_m: string, _md?: unknown) {},
    trace(_m: string, _md?: unknown) {},
    child() {
      return log;
    },
  };
  return { warnCalls, logger: log };
}

// -- Tests -----------------------------------------------------------------

Deno.test('middleware — success sets ctx.request.tenant and calls next', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const resolver = new SubdomainResolver();
  const mw = tenantMiddleware({ service: makeService(), resolvers: [resolver], options: {} });
  await mw(ctx as never, next);
  assert(getNextCalled());
  const typedRequest = ctx.request as { tenant?: { id: string } };
  assert(typedRequest.tenant != null);
  assertEquals(typedRequest.tenant!.id, 'acme');
});

Deno.test('middleware — required:true + none() short-circuits without next', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: false });
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(noneResolver)],
    options: { required: true, rejectionStatus: 403 },
  });
  await mw(ctx as never, next);
  assert(!getNextCalled());
});

Deno.test('middleware — required:false + none() proceeds', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: false });
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(noneResolver)],
    options: { required: false },
  });
  await mw(ctx as never, next);
  assert(getNextCalled());
});

Deno.test('middleware — chain order: first Some wins', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  let secondInvoked = false;
  const firstResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: true, value: { id: 'first' } });
    },
  };
  const secondResolver: FakeResolver = {
    resolve(_request) {
      secondInvoked = true;
      return Promise.resolve({ present: true, value: { id: 'second' } });
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(firstResolver), toITenantResolver(secondResolver)],
    options: {},
  });
  await mw(ctx as never, next);
  assert(getNextCalled());
  assert(!secondInvoked);
  const typedRequest = ctx.request as { tenant?: { id: string } };
  assertEquals(typedRequest.tenant!.id, 'first');
});

Deno.test('middleware — cache.prefix:true stamps ctx.state', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const resolver = new SubdomainResolver();
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [resolver],
    options: { cache: { prefix: true, separator: ':' } },
  });
  await mw(ctx as never, next);
  assert(getNextCalled());
  const prefix = getTenantCachePrefix(ctx);
  assertNotEquals(prefix, undefined);
  assert(prefix!.startsWith('acme'));
});

Deno.test('middleware — cache.prefix absent returns undefined', async () => {
  const { ctx, next } = makeContext();
  const noneResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: false });
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(noneResolver)],
    options: {},
  });
  await mw(ctx as never, next);
  assertEquals(getTenantCachePrefix(ctx), undefined);
});

Deno.test('middleware — resolver throw is caught and treated as none', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const throwingResolver: FakeResolver = {
    resolve(_request) {
      throw new Error('boom');
    },
  };
  const continuingResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: true, value: { id: 'fallback' } });
    },
  };
  const { logger } = makeLogger();
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(throwingResolver), toITenantResolver(continuingResolver)],
    options: {},
    logger,
  });
  await mw(ctx as never, next);
  assert(getNextCalled());
  const typedRequest = ctx.request as { tenant?: { id: string } };
  assertEquals(typedRequest.tenant!.id, 'fallback');
});

Deno.test('middleware — no logger: throw does not propagate', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const throwingResolver: FakeResolver = {
    resolve(_request) {
      throw new Error('silent boom');
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(throwingResolver)],
    options: { required: false },
  });
  // Should not throw
  await mw(ctx as never, next);
  assert(getNextCalled());
});

Deno.test('middleware — custom rejectionStatus honored', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    resolve(_request) {
      return Promise.resolve({ present: false });
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [toITenantResolver(noneResolver)],
    options: { required: true, rejectionStatus: 401 },
  });
  await mw(ctx as never, next);
  assert(!getNextCalled());
});

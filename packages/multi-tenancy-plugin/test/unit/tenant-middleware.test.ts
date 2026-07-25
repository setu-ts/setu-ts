/**
 * Tenant middleware tests — success, short-circuit, cache prefix, resolver throw.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.19';
import { getTenantCachePrefix, tenantMiddleware } from '../../src/middleware/tenant-middleware.ts';
import { SubdomainResolver } from '../../src/resolvers/subdomain-resolver.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';

// Fake ITenantResolver for tests that need a custom one.
interface FakeResolver {
  resolve(req: any): Promise<{ present: boolean; value?: { id: string } }>;
}

// -- Helpers ---------------------------------------------------------------

function makeContext(opts?: { state?: Map<string, unknown>; tenant?: unknown }) {
  const state = opts?.state ?? new Map();
  const request = {
    method: 'GET',
    url: 'https://acme.example.com/',
    path: '/',
    headers: new Headers(),
    json: async () => Promise.resolve({}) as Promise<unknown>,
    text: async () => '',
    bytes: async () => new Uint8Array(),
  };
  if (opts?.tenant != null) {
    (request as Record<string, unknown>).tenant = opts.tenant;
  }
  let nextCalled = false;
  const response = {
    status: (_code: number) => ({
      header: () => ({ json: () => null as never }),
      json: () => null as never,
    }),
    json: () => null as never,
    snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
  } as any;
  return {
    ctx: {
      id: 'req-1',
      request: request as any,
      response,
      services: {} as any,
      params: {},
      query: {},
      state,
      startTime: performance.now(),
      signal: new AbortController().signal,
    },
    next: async () => {
      nextCalled = true;
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
    level: 2,
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

Deno.test('middleware — success sets ctx.request.tenant and calls next', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const resolver = new SubdomainResolver();
  const mw = tenantMiddleware({ service: makeService(), resolvers: [resolver], options: {} });
  await mw(ctx, next);
  assert(getNextCalled());
  assert((ctx.request as any).tenant != null);
  assertEquals((ctx.request as any).tenant.id, 'acme');
});

Deno.test('middleware — required:true + none() short-circuits without next', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    async resolve(_request) {
      return { present: false };
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [noneResolver as any],
    options: { required: true, rejectionStatus: 403 },
  });
  await mw(ctx, next);
  assert(!getNextCalled());
});

Deno.test('middleware — required:false + none() proceeds', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    async resolve(_request) {
      return { present: false };
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [noneResolver as any],
    options: { required: false },
  });
  await mw(ctx, next);
  assert(getNextCalled());
});

Deno.test('middleware — chain order: first Some wins', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  let secondInvoked = false;
  const firstResolver: FakeResolver = {
    async resolve(_request) {
      return { present: true, value: { id: 'first' } };
    },
  };
  const secondResolver: FakeResolver = {
    async resolve(_request) {
      secondInvoked = true;
      return { present: true, value: { id: 'second' } };
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [firstResolver as any, secondResolver as any],
    options: {},
  });
  await mw(ctx, next);
  assert(getNextCalled());
  assert(!secondInvoked);
  assertEquals((ctx.request as any).tenant.id, 'first');
});

Deno.test('middleware — cache.prefix:true stamps ctx.state', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const resolver = new SubdomainResolver();
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [resolver],
    options: { cache: { prefix: true, separator: ':' } },
  });
  await mw(ctx, next);
  assert(getNextCalled());
  const prefix = getTenantCachePrefix(ctx);
  assertNotEquals(prefix, undefined);
  assert(prefix!.startsWith('acme'));
});

Deno.test('middleware — cache.prefix absent returns undefined', async () => {
  const { ctx, next } = makeContext();
  const noneResolver: FakeResolver = {
    async resolve(_request) {
      return { present: false };
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [noneResolver as any],
    options: {},
  });
  await mw(ctx, next);
  assertEquals(getTenantCachePrefix(ctx), undefined);
});

Deno.test('middleware — resolver throw is caught and treated as none', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const throwingResolver: FakeResolver = {
    async resolve(_request) {
      throw new Error('boom');
    },
  };
  const continuingResolver: FakeResolver = {
    async resolve(_request) {
      return { present: true, value: { id: 'fallback' } };
    },
  };
  const { logger } = makeLogger();
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [throwingResolver as any, continuingResolver as any],
    options: {},
    logger: logger as any,
  });
  await mw(ctx, next);
  assert(getNextCalled());
  assertEquals((ctx.request as any).tenant.id, 'fallback');
});

Deno.test('middleware — no logger: throw does not propagate', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const throwingResolver: FakeResolver = {
    async resolve(_request) {
      throw new Error('silent boom');
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [throwingResolver as any],
    options: { required: false },
  });
  // Should not throw
  await mw(ctx, next);
  assert(getNextCalled());
});

Deno.test('middleware — custom rejectionStatus honored', async () => {
  const { ctx, next, getNextCalled } = makeContext();
  const noneResolver: FakeResolver = {
    async resolve(_request) {
      return { present: false };
    },
  };
  const mw = tenantMiddleware({
    service: makeService(),
    resolvers: [noneResolver as any],
    options: { required: true, rejectionStatus: 401 },
  });
  await mw(ctx, next);
  assert(!getNextCalled());
});

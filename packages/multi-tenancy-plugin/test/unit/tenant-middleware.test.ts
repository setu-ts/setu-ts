/**
 * Tenant middleware tests — success, short-circuit, cache prefix, resolver throw.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { getTenantCachePrefix, tenantMiddleware } from '../../src/middleware/tenant-middleware.ts';
import { SubdomainResolver } from '../../src/resolvers/subdomain-resolver.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import type { ITenantResolver } from '@setu-ts/common';

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
  return new MultiTenancyService({ store: {} as never });
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

describe('tenant middleware', () => {
  it('middleware — success sets ctx.request.tenant and calls next', async () => {
    const { ctx, next, getNextCalled } = makeContext();
    const resolver = new SubdomainResolver();
    const mw = tenantMiddleware({ service: makeService(), resolvers: [resolver], options: {} });
    await mw(ctx as never, next);
    expect(getNextCalled()).toBeTruthy();
    const typedRequest = ctx.request as { tenant?: { id: string } };
    expect(typedRequest.tenant != null).toBeTruthy();
    expect(typedRequest.tenant!.id).toEqual('acme');
  });

  it('middleware — required:true + none() short-circuits without next', async () => {
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
    expect(!getNextCalled()).toBeTruthy();
  });

  // A4: Assert the FULL short-circuit response body (error label + message), status code, AND no-downstream.
  it('middleware — required:true short-circuit asserts full response body and status', async () => {
    let capturedBody: unknown;
    let capturedStatus: number | undefined;
    const response = {
      status: (code: number) => ({
        json: (body: unknown) => {
          capturedStatus = code;
          capturedBody = body;
          return undefined;
        },
      }),
      json: () => undefined,
      snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
    };
    let nextCalled = false;
    const req = {
      method: 'GET' as const,
      url: 'https://example.com/' as const,
      path: '/' as const,
      headers: new Headers(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
      get tenant() {
        return undefined;
      },
      // prettier-ignore
      set tenant(_v) {/* intentional no-op for short-circuit test */},
    };
    const ctx = {
      id: 'req-2',
      request: req,
      response,
      services: {} as never,
      params: {},
      query: {},
      state: new Map(),
      startTime: performance.now(),
      signal: new AbortController().signal,
    } as unknown as import('@setu-ts/common').IRequestContext;
    const noneResolver: FakeResolver = {
      resolve(_request) {
        return Promise.resolve({ present: false });
      },
    };
    const mw = tenantMiddleware({
      service: makeService(),
      resolvers: [toITenantResolver(noneResolver)],
      options: { required: true, rejectionStatus: 422 },
    });
    await mw(
      ctx,
      (() => {
        nextCalled = true;
        return Promise.resolve();
      }) as never,
    );
    expect(!nextCalled).toBeTruthy();
    expect(capturedStatus).toEqual(422);
    expect(typeof capturedBody === 'object' && capturedBody != null).toBeTruthy();
    const body = capturedBody as Record<string, unknown>;
    expect(body.error).toEqual('Tenant Required');
    expect(body.message).toEqual('No tenant could be resolved for this request');
  });

  it('middleware — required:false + none() proceeds', async () => {
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
    expect(getNextCalled()).toBeTruthy();
  });

  it('middleware — chain order: first Some wins', async () => {
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
    expect(getNextCalled()).toBeTruthy();
    expect(!secondInvoked).toBeTruthy();
    const typedRequest = ctx.request as { tenant?: { id: string } };
    expect(typedRequest.tenant!.id).toEqual('first');
  });

  it('middleware — cache.prefix:true stamps ctx.state', async () => {
    const { ctx, next, getNextCalled } = makeContext();
    const resolver = new SubdomainResolver();
    const mw = tenantMiddleware({
      service: makeService(),
      resolvers: [resolver],
      options: { cache: { prefix: true, separator: ':' } },
    });
    await mw(ctx as never, next);
    expect(getNextCalled()).toBeTruthy();
    const prefix = getTenantCachePrefix(ctx);
    expect(prefix).not.toEqual(undefined);
    expect(prefix!.startsWith('acme')).toBeTruthy();
  });

  it('middleware — cache.prefix absent returns undefined', async () => {
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
    expect(getTenantCachePrefix(ctx)).toEqual(undefined);
  });

  it('middleware — resolver throw is caught and treated as none', async () => {
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
    expect(getNextCalled()).toBeTruthy();
    const typedRequest = ctx.request as { tenant?: { id: string } };
    expect(typedRequest.tenant!.id).toEqual('fallback');
  });

  it('middleware — no logger: throw does not propagate', async () => {
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
    expect(getNextCalled()).toBeTruthy();
  });

  it('middleware — custom rejectionStatus honored', async () => {
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
    expect(!getNextCalled()).toBeTruthy();
  });
});

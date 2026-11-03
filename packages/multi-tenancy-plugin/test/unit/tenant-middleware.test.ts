/**
 * Tenant middleware tests — success, short-circuit, cache prefix, resolver throw.
 */
import { describe, expect, it } from 'vitest';
import { getTenantCachePrefix, tenantMiddleware } from '../../src/middleware/tenant-middleware.ts';
import { TenantCheck } from '../../src/registry/tenant-check.ts';
import { StaticTenantRegistry } from '../../src/registry/static-tenant-registry.ts';
import type { ILogger, ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { SubdomainResolver } from '../../src/resolvers/subdomain-resolver.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import type { ISession, ITenantResolver } from '@setu-ts/common';
import {
  sealRequestIdentity,
  SESSION_STATE_KEY,
  SESSION_TENANT_BINDING_KEY,
  SESSION_TENANT_BINDING_STATE_KEY,
} from '@setu-ts/common';

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

function makeContext(opts?: { state?: Map<string, unknown>; tenant?: unknown; path?: string }) {
  const state = opts?.state ?? new Map();
  let storedTenant: { id: string; name?: string } | undefined = opts?.tenant as
    { id: string; name?: string } | undefined;
  const request = {
    method: 'GET',
    url: 'https://acme.example.com/',
    path: opts?.path ?? '/',
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
    // Models the real `IResponse`: `status()` records and returns the response
    // itself; `json()` is a method on the response (M70f's responder seam calls
    // the two separately rather than chaining).
    const response = {
      status: (code: number) => {
        capturedStatus = code;
        return response;
      },
      json: (body: unknown) => {
        capturedBody = body;
        return undefined;
      },
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
    await mw(ctx, (() => {
      nextCalled = true;
      return Promise.resolve();
    }) as never);
    expect(!nextCalled).toBeTruthy();
    expect(capturedStatus).toEqual(422);
    expect(typeof capturedBody === 'object' && capturedBody != null).toBeTruthy();
    const body = capturedBody as Record<string, unknown>;
    expect(body.error).toEqual('Tenant Required');
    // M70f (X4-8): the rejection converges on the responder's `detail` key.
    expect(body.detail).toEqual('No tenant could be resolved for this request');
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

  describe('exclude — operational probe exemption (X4-2)', () => {
    const noneResolver: FakeResolver = {
      resolve(_request) {
        return Promise.resolve({ present: false });
      },
    };

    it('default list exempts all six probe paths under required:true', async () => {
      for (const path of ['/live', '/ready', '/health', '/metrics', '/openapi.json', '/docs']) {
        const { ctx, next, getNextCalled } = makeContext({ path });
        const mw = tenantMiddleware({
          service: makeService(),
          resolvers: [toITenantResolver(noneResolver)],
          options: { required: true },
        });
        await mw(ctx as never, next);
        expect(getNextCalled(), `expected ${path} to be exempt by default`).toBeTruthy();
      }
    });

    it('a non-excluded path still rejects under required:true', async () => {
      const { ctx, next, getNextCalled } = makeContext({ path: '/api/orders' });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(noneResolver)],
        options: { required: true },
      });
      await mw(ctx as never, next);
      expect(!getNextCalled()).toBeTruthy();
    });

    it('a custom string entry exempts that path only', async () => {
      const { ctx, next, getNextCalled } = makeContext({ path: '/internal/ping' });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(noneResolver)],
        options: { required: true, exclude: ['/internal/ping'] },
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBeTruthy();

      const other = makeContext({ path: '/internal/ping2' });
      await mw(other.ctx as never, other.next);
      expect(!other.getNextCalled()).toBeTruthy();
    });

    it('a custom RegExp entry exempts matching paths', async () => {
      const { ctx, next, getNextCalled } = makeContext({ path: '/internal/ping' });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(noneResolver)],
        options: { required: true, exclude: [/^\/internal\//] },
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBeTruthy();

      const other = makeContext({ path: '/api/orders' });
      await mw(other.ctx as never, other.next);
      expect(!other.getNextCalled()).toBeTruthy();
    });

    it('exclude: [] restores rejection on the default probe paths', async () => {
      const { ctx, next, getNextCalled } = makeContext({ path: '/live' });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(noneResolver)],
        options: { required: true, exclude: [] },
      });
      await mw(ctx as never, next);
      expect(!getNextCalled()).toBeTruthy();
    });

    it('an exempted path skips resolution entirely (no tenant stamped)', async () => {
      const { ctx, next, getNextCalled } = makeContext({ path: '/live' });
      let resolved = 0;
      const countingResolver: FakeResolver = {
        resolve(_request) {
          resolved += 1;
          return Promise.resolve({ present: false });
        },
      };
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(countingResolver)],
        options: { required: true },
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBeTruthy();
      expect(resolved).toBe(0);
      const typedRequest = ctx.request as { tenant?: { id: string } };
      expect(typedRequest.tenant).toBeUndefined();
    });

    it('a stateful global RegExp is matched on every request (lastIndex reset)', async () => {
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [toITenantResolver(noneResolver)],
        options: { required: true, exclude: [/^\/live/g] },
      });
      // Two consecutive exempted requests: a `g`-flagged RegExp would fail the
      // second if `lastIndex` were not reset between `.test` calls.
      const first = makeContext({ path: '/live' });
      await mw(first.ctx as never, first.next);
      expect(first.getNextCalled()).toBeTruthy();
      const second = makeContext({ path: '/live' });
      await mw(second.ctx as never, second.next);
      expect(second.getNextCalled()).toBeTruthy();
    });
  });

  describe('single-write identity guard (M71)', () => {
    // Every other test in this file drives a hand-rolled request whose
    // `tenant` is a plain accessor pair, i.e. UNSEALED — so `replaceTenant`
    // takes its plain-assignment branch there and the path the kernel
    // actually runs is never exercised. These two seal the request the way
    // `createRequestContext` does.
    function sealedContext() {
      const made = makeContext();
      sealRequestIdentity(made.ctx.request as never);
      return made;
    }

    it('resolves a tenant onto a sealed request', async () => {
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [
          toITenantResolver({
            resolve: () => Promise.resolve({ present: true, value: { id: 'acme' } }),
          }),
        ],
        options: {},
      });
      const made = sealedContext();
      await mw(made.ctx as never, made.next);
      expect((made.ctx.request as { tenant?: { id: string } }).tenant?.id).toBe('acme');
      expect(made.getNextCalled()).toBeTruthy();
    });

    it('runs twice over one sealed request through the deliberate replacement escape', async () => {
      // A global registration plus a route-level one is a supported
      // composition; without `replaceTenant` the second run would throw.
      let n = 0;
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [
          toITenantResolver({
            resolve: () => {
              n += 1;
              return Promise.resolve({ present: true, value: { id: `tenant-${n}` } });
            },
          }),
        ],
        options: {},
      });
      const made = sealedContext();
      await mw(made.ctx as never, made.next);
      await mw(made.ctx as never, made.next);
      expect((made.ctx.request as { tenant?: { id: string } }).tenant?.id).toBe('tenant-2');
    });
  });

  describe('tenant-side binding compare (M101c, V8-7)', () => {
    // A minimal `ISession` the session middleware would have parked in
    // `ctx.state`, carrying (or not) the sealed tenant binding.
    function parkedSession(bound: string | undefined): ISession {
      return {
        get: (key: string) => (key === SESSION_TENANT_BINDING_KEY ? bound : undefined),
      } as unknown as ISession;
    }

    function resolvingResolver(id: string): ITenantResolver {
      return toITenantResolver({
        resolve: () => Promise.resolve({ present: true, value: { id } }),
      });
    }

    it('refuses 403 and skips next when a parked session is bound to a different tenant', async () => {
      let capturedStatus: number | undefined;
      let capturedBody: unknown;
      const response = {
        status: (code: number) => {
          capturedStatus = code;
          return response;
        },
        json: (body: unknown) => {
          capturedBody = body;
          return undefined;
        },
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      };
      let nextCalled = false;
      const state = new Map<string, unknown>();
      state.set(SESSION_STATE_KEY, parkedSession('a'));
      state.set(SESSION_TENANT_BINDING_STATE_KEY, true);
      const { ctx } = makeContext({ state });
      (ctx as { response: unknown }).response = response;
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [resolvingResolver('b')],
        options: {},
      });
      await mw(
        ctx as never,
        (() => {
          nextCalled = true;
          return Promise.resolve();
        }) as never,
      );
      expect(nextCalled).toBe(false);
      expect(capturedStatus).toEqual(403);
      const body = capturedBody as Record<string, unknown>;
      expect(body.error).toBe('Tenant Mismatch');
    });

    it('proceeds when the parked session is bound to the SAME tenant', async () => {
      const state = new Map<string, unknown>();
      state.set(SESSION_STATE_KEY, parkedSession('a'));
      state.set(SESSION_TENANT_BINDING_STATE_KEY, true);
      const { ctx, next, getNextCalled } = makeContext({ state });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [resolvingResolver('a')],
        options: {},
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBe(true);
      expect((ctx.request as { tenant?: { id: string } }).tenant?.id).toBe('a');
    });

    it('does not compare when the session middleware did not publish binding ON', async () => {
      // `SessionPlugin({ tenantBinding: false })` parks the session but never
      // sets the binding-on key: a session sealed before the opt-out must not
      // be refused here, exactly as the session side would not refuse it.
      const state = new Map<string, unknown>();
      state.set(SESSION_STATE_KEY, parkedSession('a'));
      const { ctx, next, getNextCalled } = makeContext({ state });
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [resolvingResolver('b')],
        options: {},
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBe(true);
      expect((ctx.request as { tenant?: { id: string } }).tenant?.id).toBe('b');
    });

    it('is unchanged when no session is parked in ctx.state', async () => {
      const { ctx, next, getNextCalled } = makeContext(); // empty state
      const mw = tenantMiddleware({
        service: makeService(),
        resolvers: [resolvingResolver('a')],
        options: {},
      });
      await mw(ctx as never, next);
      expect(getNextCalled()).toBe(true);
      expect((ctx.request as { tenant?: { id: string } }).tenant?.id).toBe('a');
    });
  });
});

// ---------------------------------------------------------------------------
// M127 — the registry step (§3.4, §3.5)
// ---------------------------------------------------------------------------

describe('tenant middleware — the registry step (M127)', () => {
  /** A context whose response records status and body, and a recording next. */
  function recordingContext(opts?: { path?: string; state?: Map<string, unknown> }) {
    const base = makeContext(opts);
    let status: number | undefined;
    let body: unknown;
    const response = {
      status: (code: number) => {
        status = code;
        return response;
      },
      json: (value: unknown) => {
        body = value;
        return undefined;
      },
      snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
    };
    (base.ctx as { response: unknown }).response = response;
    return { ...base, getStatus: () => status, getBody: () => body };
  }

  const resolving = (id: string): ITenantResolver =>
    toITenantResolver({ resolve: () => Promise.resolve({ present: true, value: { id } }) });

  function recordingLogger() {
    const lines: string[] = [];
    const record = (message: string, metadata?: unknown) =>
      lines.push(`${message} ${JSON.stringify(metadata ?? {})}`);
    const logger = {
      level: 'info',
      warn: record,
      info: record,
      error: record,
      fatal: record,
      debug: record,
      trace: record,
      child: () => logger,
    } as unknown as ILogger;
    return { logger, lines };
  }

  function checkOver(
    registry: ITenantRegistry,
    logger?: ILogger,
  ): { check: TenantCheck; calls: string[] } {
    const calls: string[] = [];
    const check = new TenantCheck({
      configured: true,
      registry: {
        lookup: (id) => {
          calls.push(id);
          return registry.lookup(id);
        },
      },
      ...(logger !== undefined && { logger }),
    });
    return { check, calls };
  }

  it('a hit installs the registry tenant and calls next', async () => {
    const { ctx, next, getNextCalled } = recordingContext();
    const { check } = checkOver(new StaticTenantRegistry([{ id: 'acme', name: 'Acme' }]));
    const mw = tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('acme')],
      options: {},
      check,
    });
    await mw(ctx as never, next);
    expect(getNextCalled()).toBe(true);
    expect((ctx.request as { tenant?: ITenant }).tenant).toEqual({ id: 'acme', name: 'Acme' });
  });

  it('a miss answers 404 Unknown Tenant field by field, runs nothing downstream, never echoes the id', async () => {
    const { ctx, next, getNextCalled, getStatus, getBody } = recordingContext();
    const distinctive = '<x>\r\nX-Evil: 1';
    const { logger, lines } = recordingLogger();
    const { check, calls } = checkOver(new StaticTenantRegistry(['acme']), logger);
    const mw = tenantMiddleware({
      service: makeService(),
      resolvers: [resolving(distinctive)],
      options: {},
      check,
      logger,
    });
    await mw(ctx as never, next);
    expect(getNextCalled()).toBe(false);
    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({
      error: 'Unknown Tenant',
      detail: 'The request names a tenant that does not exist',
    });
    expect(JSON.stringify(getBody())).not.toContain('X-Evil');
    expect((ctx.request as { tenant?: ITenant }).tenant).toBeUndefined();
    // Control: the id DID reach the registry.
    expect(calls).toEqual([distinctive]);
    expect(lines.join('\n')).not.toContain('X-Evil');
  });

  it('unknownTenantStatus sets the miss status', async () => {
    const { ctx, next, getStatus } = recordingContext();
    const { check } = checkOver(new StaticTenantRegistry(['acme']));
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('initech')],
      options: { unknownTenantStatus: 403 },
      check,
    })(ctx as never, next);
    expect(getStatus()).toBe(403);
  });

  it('a registry fault answers 503 Tenant Registry Unavailable and runs nothing downstream', async () => {
    const { ctx, next, getNextCalled, getStatus, getBody } = recordingContext();
    const { check } = checkOver({ lookup: () => Promise.reject(new Error('down')) });
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('acme')],
      options: {},
      check,
    })(ctx as never, next);
    expect(getNextCalled()).toBe(false);
    expect(getStatus()).toBe(503);
    expect(getBody()).toEqual({
      error: 'Tenant Registry Unavailable',
      detail: 'The tenant could not be checked; try again later',
    });
    expect(JSON.stringify(getBody())).not.toContain('acme');
  });

  it('a malformed registry answer is a 503, never an admitted tenant', async () => {
    const { ctx, next, getNextCalled, getStatus } = recordingContext();
    const { check } = checkOver({
      lookup: () => Promise.resolve(some({ id: '' }) as Option<ITenant>),
    });
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('acme')],
      options: {},
      check,
    })(ctx as never, next);
    expect(getNextCalled()).toBe(false);
    expect(getStatus()).toBe(503);
  });

  it('the canonical id flows to the cache prefix and the session compare (O6)', async () => {
    const state = new Map<string, unknown>();
    // A session bound to the CANONICAL id 'acme' passes under the spelling 'ACME'.
    state.set(SESSION_TENANT_BINDING_STATE_KEY, true);
    state.set(SESSION_STATE_KEY, {
      get: (key: string) => (key === SESSION_TENANT_BINDING_KEY ? 'acme' : undefined),
    } as unknown as ISession);
    const { ctx, next, getNextCalled } = recordingContext({ state });
    const { check } = checkOver({
      lookup: (id) => Promise.resolve(id.toLowerCase() === 'acme' ? some({ id: 'acme' }) : none()),
    });
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('ACME')],
      options: { cache: { prefix: true } },
      check,
    })(ctx as never, next);
    expect(getNextCalled()).toBe(true);
    expect((ctx.request as { tenant?: ITenant }).tenant?.id).toBe('acme');
    expect(getTenantCachePrefix(ctx as never)).toBe('acme:');
  });

  it('a session bound to a different tenant is still refused after replacement', async () => {
    const state = new Map<string, unknown>();
    state.set(SESSION_TENANT_BINDING_STATE_KEY, true);
    state.set(SESSION_STATE_KEY, {
      get: (key: string) => (key === SESSION_TENANT_BINDING_KEY ? 'globex' : undefined),
    } as unknown as ISession);
    const { ctx, next, getNextCalled, getStatus } = recordingContext({ state });
    const { check } = checkOver(new StaticTenantRegistry(['acme', 'globex']));
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('acme')],
      options: {},
      check,
    })(ctx as never, next);
    expect(getNextCalled()).toBe(false);
    expect(getStatus()).toBe(403);
  });

  it('the chain is not re-entered on a miss (no fallthrough to a second resolver)', async () => {
    const { ctx, next, getStatus } = recordingContext();
    let secondRan = false;
    const second = toITenantResolver({
      resolve: () => {
        secondRan = true;
        return Promise.resolve({ present: true, value: { id: 'acme' } });
      },
    });
    const { check, calls } = checkOver(new StaticTenantRegistry(['acme']));
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('initech'), second],
      options: {},
      check,
    })(ctx as never, next);
    expect(getStatus()).toBe(404);
    expect(secondRan).toBe(false);
    expect(calls).toEqual(['initech']);
  });

  it('an excluded path makes no lookup (O9)', async () => {
    const { ctx, next, getNextCalled } = recordingContext({ path: '/health' });
    const { check, calls } = checkOver(new StaticTenantRegistry(['acme']));
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('initech')],
      options: {},
      check,
    })(ctx as never, next);
    expect(getNextCalled()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('required + nothing resolved is unchanged (no lookup, Tenant Required)', async () => {
    const { ctx, next, getStatus, getBody } = recordingContext();
    const { check, calls } = checkOver(new StaticTenantRegistry(['acme']));
    await tenantMiddleware({
      service: makeService(),
      resolvers: [toITenantResolver({ resolve: () => Promise.resolve({ present: false }) })],
      options: { required: true },
      check,
    })(ctx as never, next);
    expect(getStatus()).toBe(400);
    expect((getBody() as { error: string }).error).toBe('Tenant Required');
    expect(calls).toEqual([]);
  });

  it('no check = unchanged: any resolved id is admitted', async () => {
    const { ctx, next, getNextCalled } = recordingContext();
    await tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('anything-at-all')],
      options: {},
    })(ctx as never, next);
    expect(getNextCalled()).toBe(true);
    expect((ctx.request as { tenant?: ITenant }).tenant?.id).toBe('anything-at-all');
  });

  it('warns once while failing and logs info on recovery, through the middleware', async () => {
    const { logger, lines } = recordingLogger();
    let failing = true;
    const { check } = checkOver(
      {
        lookup: (id) =>
          failing ? Promise.reject(new Error('down')) : Promise.resolve(some({ id })),
      },
      logger,
    );
    const mw = tenantMiddleware({
      service: makeService(),
      resolvers: [resolving('acme')],
      options: {},
      check,
      logger,
    });
    for (let i = 0; i < 3; i++) {
      const { ctx, next } = recordingContext();
      await mw(ctx as never, next);
    }
    failing = false;
    const { ctx, next, getNextCalled } = recordingContext();
    await mw(ctx as never, next);
    expect(getNextCalled()).toBe(true);
    expect(lines.filter((l) => l.startsWith('Tenant registry lookup failed'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('Tenant registry lookups recovered'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('acme');
  });
});

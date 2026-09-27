/**
 * Tests for authorization guard middleware factories.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  publicRoute,
  requireAllPermissions,
  requireAnyRole,
  requireAuth,
  requirePermission,
  requireRole,
} from '../../src/guards/index.ts';
import type {
  HandlerResult,
  IAuthorizationService,
  IPrincipal,
  IRequestContext,
  IResponse,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import {
  AuthorizationObservationCollector,
  compileAuthorizationDiagnosticsOptions,
} from '../../src/diagnostics/authorization-observation-collector.ts';
import type { AuthorizationObserver } from '../../src/diagnostics/authorization-observer.ts';
import { attachAuthorizationObserver } from '../../src/diagnostics/authorization-observer.ts';
import { RbacService } from '../../src/services/rbac-service.ts';

/**
 * Create a fake response that records the status and body.
 */
function createFakeResponse(): {
  response: IResponse;
  status: number;
  body: unknown;
} {
  let statusCode = 200;
  let body: unknown = null;
  const response: IResponse = {
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    header: () => response,
    appendHeader: () => response,
    json: <T>(b: T): HandlerResult => {
      body = b;
      return { __handlerResult: true };
    },
    text: (b: string): HandlerResult => {
      body = b;
      return { __handlerResult: true };
    },
    html: (b: string): HandlerResult => {
      body = b;
      return { __handlerResult: true };
    },
    send: (b?: Uint8Array): HandlerResult => {
      body = b;
      return { __handlerResult: true };
    },
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    stream: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ streaming: false, status: statusCode, headers: new Headers(), body: null }),
  };
  return {
    response,
    get status() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

/**
 * Create a fake request context with controllable user and services.
 */
function createContext(opts: {
  user?: IPrincipal;
  authz?: IAuthorizationService;
}): { ctx: IRequestContext; response: ReturnType<typeof createFakeResponse> } {
  let statusCode = 200;
  let respBody: unknown = null;
  const _abortCtrl = new AbortController();
  const resp: IResponse = {
    status: (code: number) => {
      statusCode = code;
      return resp;
    },
    header: () => resp,
    appendHeader: () => resp,
    json: <T>(b: T): HandlerResult => {
      respBody = b;
      return { __handlerResult: true };
    },
    text: (b: string): HandlerResult => {
      respBody = b;
      return { __handlerResult: true };
    },
    html: (b: string): HandlerResult => {
      respBody = b;
      return { __handlerResult: true };
    },
    send: (b?: Uint8Array): HandlerResult => {
      respBody = b;
      return { __handlerResult: true };
    },
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    stream: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ streaming: false, status: statusCode, headers: new Headers(), body: null }),
  };

  const services = {
    get: <T>(token: string): T => {
      if (token === 'authorization') {
        return opts.authz as T;
      }
      throw new Error(`unexpected token: ${token}`);
    },
    has: () => true,
    register: () => {},
  } as unknown as IServiceRegistry;

  const request = {
    method: 'GET',
    url: '/',
    path: '/',
    headers: new Headers(),
    ...(opts.user ? { user: opts.user } : {}),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };

  const ctx: IRequestContext = {
    id: 'test',
    request: request as never,
    response: resp,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
    signal: _abortCtrl.signal,
  };

  return {
    ctx,
    response: {
      response: resp,
      get status() {
        return statusCode;
      },
      get body() {
        return respBody;
      },
    },
  };
}

/**
 * Create a next function that tracks calls via a mutable counter.
 * IMPORTANT: callers must access `.calls` from the returned object
 * (not destructured) because destructuring snapshots the value.
 */
function createNext(): { next: () => Promise<void>; calls: number } {
  const tracker: { next: () => Promise<void>; calls: number } = {
    calls: 0,
    next: () => {
      tracker.calls++;
      return Promise.resolve();
    },
  };
  return tracker;
}

describe('requireAuth', () => {
  it('calls next when a principal is present', async () => {
    const guard = requireAuth();
    const { ctx } = createContext({ user: { id: 'u1' } });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('returns 401 and does NOT call next when no principal', async () => {
    const guard = requireAuth();
    const { ctx, response } = createContext({});
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(401);
    expect(nt.calls).toBe(0);
  });
});

describe('requireRole', () => {
  const authz: IAuthorizationService = {
    hasRole: (_p: IPrincipal, role: string) => role === 'admin',
    hasPermission: () => false,
    hasAnyRole: () => false,
    hasAllPermissions: () => false,
  };

  it('calls next when principal has the role', async () => {
    const guard = requireRole('admin');
    const { ctx } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('returns 401 when no principal', async () => {
    const guard = requireRole('admin');
    const { ctx, response } = createContext({ authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(401);
    expect(nt.calls).toBe(0);
  });

  it('returns 403 when principal lacks the role', async () => {
    const guard = requireRole('superadmin');
    const { ctx, response } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ detail: 'Insufficient privileges' });
    expect(nt.calls).toBe(0);
  });
});

describe('requirePermission', () => {
  const authz: IAuthorizationService = {
    hasRole: () => false,
    hasPermission: (_p: IPrincipal, perm: string) => perm === 'users:write',
    hasAnyRole: () => false,
    hasAllPermissions: () => false,
  };

  it('calls next when principal has the permission', async () => {
    const guard = requirePermission('users:write');
    const { ctx } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('returns 401 when no principal', async () => {
    const guard = requirePermission('users:write');
    const { ctx, response } = createContext({ authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(401);
    expect(nt.calls).toBe(0);
  });

  it('returns 403 when principal lacks the permission', async () => {
    const guard = requirePermission('users:delete');
    const { ctx, response } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ detail: 'Insufficient privileges' });
    expect(nt.calls).toBe(0);
  });
});

describe('requireAnyRole', () => {
  const authz: IAuthorizationService = {
    hasRole: () => false,
    hasPermission: () => false,
    hasAnyRole: (_p: IPrincipal, roles: readonly string[]) => roles.includes('manager'),
    hasAllPermissions: () => false,
  };

  it('calls next when principal has any of the roles', async () => {
    const guard = requireAnyRole(['admin', 'manager']);
    const { ctx } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('returns 403 when principal has none of the roles', async () => {
    const guard = requireAnyRole(['admin', 'superadmin']);
    const { ctx, response } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ detail: 'Insufficient privileges' });
    expect(nt.calls).toBe(0);
  });

  it('returns 401 when no principal', async () => {
    const guard = requireAnyRole(['admin']);
    const { ctx, response } = createContext({ authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(401);
    expect(nt.calls).toBe(0);
  });
});

describe('requireAllPermissions', () => {
  const authz: IAuthorizationService = {
    hasRole: () => false,
    hasPermission: () => false,
    hasAnyRole: () => false,
    hasAllPermissions: (_p: IPrincipal, perms: readonly string[]) =>
      perms.every((p) => p === 'users:read' || p === 'users:write'),
  };

  it('calls next when principal has all permissions', async () => {
    const guard = requireAllPermissions(['users:read', 'users:write']);
    const { ctx } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('returns 403 when principal is missing a permission', async () => {
    const guard = requireAllPermissions(['users:read', 'users:delete']);
    const { ctx, response } = createContext({ user: { id: 'u1' }, authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ detail: 'Insufficient privileges' });
    expect(nt.calls).toBe(0);
  });

  it('returns 401 when no principal', async () => {
    const guard = requireAllPermissions(['users:read']);
    const { ctx, response } = createContext({ authz });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(401);
    expect(nt.calls).toBe(0);
  });
});

describe('publicRoute', () => {
  it('always calls next', async () => {
    const guard = publicRoute();
    const { ctx } = createContext({});
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('calls next even when no principal', async () => {
    const guard = publicRoute();
    const { ctx } = createContext({});
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('calls next when a principal is present', async () => {
    const guard = publicRoute();
    const { ctx } = createContext({ user: { id: 'u1' } });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });
});

describe('guards with an attached authorization observer (M98h)', () => {
  const RBAC_CONFIG = {
    roles: {
      admin: { permissions: ['posts.read', 'posts.write'], inherits: ['editor'] },
      editor: { permissions: ['posts.read'] },
    },
  };

  /** The registry the collector verifies against: the first-party provider. */
  function currentRegistry(): IServiceRegistry {
    return {
      isCurrent: (_token: unknown, _instance: unknown) => true,
    } as unknown as IServiceRegistry;
  }

  function attachedRbac(): {
    rbac: RbacService;
    collector: AuthorizationObservationCollector;
  } {
    const rbac = new RbacService(RBAC_CONFIG);
    const clock = { hrtime: () => 1000 } as unknown as IRuntimeServices;
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: { admin: 'A', editor: 'E', owner: 'O' },
      permissions: { 'posts.read': 'R', 'posts.write': 'W' },
    });
    const collector = new AuthorizationObservationCollector(policy, clock, currentRegistry(), rbac);
    attachAuthorizationObserver(rbac, collector);
    return { rbac, collector };
  }

  /** A throwing observer that records how many times its seam methods ran. */
  function throwingObserver(): { observer: AuthorizationObserver; calls: { value: number } } {
    const calls = { value: 0 };
    const fail = () => {
      calls.value += 1;
      throw new Error('diagnostic boom');
    };
    const observer: AuthorizationObserver = {
      onRole: fail,
      onPermission: fail,
      onAnyRole: fail,
      onAllPermissions: fail,
    };
    return { observer, calls };
  }

  const admin: IPrincipal = { id: 'u1', roles: ['admin'] };

  it('answers the same 403 and evaluates exactly once when the observer is absent', async () => {
    const { rbac } = attachedRbac();
    attachAuthorizationObserver(rbac, undefined as never);
    // `owner` is a configured role the principal does not hold.
    const guard = requireRole('owner');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(nt.calls).toBe(0);
  });

  it('answers the same 403 and evaluates exactly once when the observer is enabled', async () => {
    const { rbac, collector } = attachedRbac();
    const guard = requireRole('owner');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    // Same refusal as without observation — the observer cannot permit.
    expect(response.status).toBe(403);
    expect(nt.calls).toBe(0);
    // One evaluation produced exactly one retained decision.
    expect(collector.read('instance', 0).decisions).toHaveLength(1);
  });

  it('answers the same 200 and evaluates exactly once when the observer is enabled', async () => {
    const { rbac, collector } = attachedRbac();
    const guard = requireRole('admin');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(200);
    expect(nt.calls).toBe(1);
    expect(collector.read('instance', 0).decisions).toHaveLength(1);
  });

  it('answers the same 403 and short-circuits when the observer throws', async () => {
    const { rbac } = attachedRbac();
    const { observer, calls } = throwingObserver();
    attachAuthorizationObserver(rbac, observer);
    const guard = requireRole('owner');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    // The throw is swallowed at the seam: the refusal is unchanged and the
    // guard short-circuits without next().
    expect(response.status).toBe(403);
    expect(nt.calls).toBe(0);
    // The guard evaluated the role exactly once — no retry, no second pass.
    expect(calls.value).toBe(1);
  });

  it('answers the same 200 when the observer throws on the allow path', async () => {
    const { rbac } = attachedRbac();
    const { observer, calls } = throwingObserver();
    attachAuthorizationObserver(rbac, observer);
    const guard = requirePermission('posts.write');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(200);
    expect(nt.calls).toBe(1);
    expect(calls.value).toBe(1);
  });

  it('answers the same 403 when a full collector ring cannot buffer', async () => {
    const { rbac, collector } = attachedRbac();
    // Fill and then overfill the 1,024-decision ring so the next buffer
    // evicts the oldest: the observation path works at capacity.
    for (let index = 0; index < 1025; index += 1) {
      rbac.hasRole(admin, 'admin');
    }
    const guard = requireRole('owner');
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(403);
    expect(nt.calls).toBe(0);
    const batch = collector.read('instance', 0, 128);
    expect(batch.decisions).toHaveLength(128);
    // The guard's evaluation was the 1,026th: two sequences were evicted, so
    // the oldest retained is 3 and the per-batch gap is 2.
    expect(batch.decisions[0]!.sequence).toBe(3);
    expect(batch.lost).toBe(2);
  });

  it('evaluates a compound guard exactly once through the real service', async () => {
    const { rbac, collector } = attachedRbac();
    const guard = requireAllPermissions(['posts.read', 'posts.write']);
    const { ctx, response } = createContext({ user: admin, authz: rbac });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(response.status).toBe(200);
    expect(nt.calls).toBe(1);
    // One compound decision with the two evaluated steps — the guard did not
    // fan out into single-check records.
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.operation).toBe('all-permissions');
    expect(decision.stepsEvaluated).toBe(2);
    expect(decision.steps).toHaveLength(2);
  });
});

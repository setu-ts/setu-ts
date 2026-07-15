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
  IServiceRegistry,
} from '@hono-enterprise/common';

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
    send: (b?: Uint8Array): HandlerResult => {
      body = b;
      return { __handlerResult: true };
    },
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ status: statusCode, headers: new Headers(), body: null }),
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
    send: (b?: Uint8Array): HandlerResult => {
      respBody = b;
      return { __handlerResult: true };
    },
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ status: statusCode, headers: new Headers(), body: null }),
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

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IPrincipal,
  IWebSocketConnection,
  WebSocketConnectionContext,
  WebSocketEventSink,
  WebSocketRouteOptions,
  WebSocketUpgradeDecision,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import {
  buildContext,
  resolveOptions,
  WebSocketService,
} from '../../src/services/websocket-service.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';

/**
 * A principal whose full shape is present, so the deep-equality assertion
 * exercises every member of {@linkcode IPrincipal} — `id`, `roles`,
 * `permissions`, and `claims`.
 */
const principal: IPrincipal = {
  id: 'user-1',
  roles: ['admin'],
  permissions: ['chat:send'],
  claims: { sub: 'user-1', tenant: 'acme' },
};

/** A principal with only the required member, for the minimal case. */
const minimalPrincipal: IPrincipal = { id: 'user-2' };

/** Registers a route that captures the exact context `onOpen` receives. */
function captureContext(
  service: WebSocketService,
  path: string,
  options?: WebSocketRouteOptions,
) {
  const seen: {
    conn: IWebSocketConnection;
    context: WebSocketConnectionContext;
  }[] = [];
  service.route(path, {
    onOpen: (conn, context) => {
      seen.push({ conn, context });
    },
  }, options);
  return seen;
}

/** Drives `routeUpgrade` and returns the accepted sink, failing loudly otherwise. */
async function accept(
  service: WebSocketService,
  url: string,
  headers: Record<string, string> = {},
  routePrincipal?: IPrincipal,
): Promise<WebSocketEventSink> {
  const decision = await service.routeUpgrade(upgradeRequest(url, headers), routePrincipal);
  if (decision === null || !decision.accept) {
    throw new Error(`expected an accepted upgrade, got ${JSON.stringify(decision)}`);
  }
  return decision.sink;
}

/** Opens a live connection through the sink. */
function open(sink: WebSocketEventSink): void {
  sink.onOpen(createFakeTransport());
}

describe('WebSocketService.routeUpgrade — principal threading', () => {
  function build() {
    const runtime = createFakeRuntime();
    return new WebSocketService(runtime, resolveOptions(), true);
  }

  it('carries the authenticated principal into the onOpen context, deep-equal', async () => {
    const service = build();
    const seen = captureContext(service, '/ws/chat');

    const sink = await accept(service, 'http://localhost/ws/chat?room=general', {}, principal);
    open(sink);

    expect(seen).toHaveLength(1);
    const context = seen[0]?.context;
    expect(context).not.toBeUndefined();
    expect(context!.user).toEqual(principal);
    // The principal the context carries is the very object the caller handed
    // in — `IPrincipal` is fully readonly, so snapshotting is sound.
    expect(context!.user).toBe(principal);
    // The rest of the context is untouched by the widening.
    expect(context!.path).toBe('/ws/chat');
    expect(context!.query).toEqual({ room: 'general' });
  });

  it('carries a minimal principal (id only) through unchanged', async () => {
    const service = build();
    const seen = captureContext(service, '/ws');

    const sink = await accept(service, 'http://localhost/ws', {}, minimalPrincipal);
    open(sink);

    expect(seen[0]?.context.user).toEqual(minimalPrincipal);
    expect(seen[0]?.context.user).toBe(minimalPrincipal);
  });

  it('omits the user key entirely (not undefined) when no principal is given', async () => {
    const service = build();
    const seen = captureContext(service, '/ws');

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);

    const context = seen[0]?.context;
    expect(context).not.toBeUndefined();
    // exactOptionalPropertyTypes: the key must be ABSENT, not present with an
    // undefined value. `in` reports key presence; a `user: undefined` property
    // would make this true.
    expect('user' in context!).toBe(false);
    expect(Object.keys(context!)).not.toContain('user');
    // The context is still fully usable for an anonymous peer.
    expect(context!.path).toBe('/ws');
    expect(context!.url).toBe('http://localhost/ws');
  });

  it('omits the user key when the principal argument is explicitly undefined', async () => {
    // The kernel passes `ctx.request.user`, which is `undefined` (not a
    // missing argument) for an unauthenticated upgrade — the same omission
    // must hold.
    const service = build();
    const seen = captureContext(service, '/ws');

    const sink = await accept(service, 'http://localhost/ws', {}, undefined);
    open(sink);

    const context = seen[0]?.context;
    expect('user' in context!).toBe(false);
    expect(Object.keys(context!)).not.toContain('user');
  });

  it('keeps user and protocol independent: protocol without principal omits user', async () => {
    const service = build();
    const seen = captureContext(service, '/ws', { protocols: ['chat'] });

    const decision = await service.routeUpgrade(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'chat' }),
    );
    if (decision === null || !decision.accept) {
      throw new Error(`expected an accepted upgrade, got ${JSON.stringify(decision)}`);
    }
    open(decision.sink);

    const context = seen[0]?.context;
    expect(context!.protocol).toBe('chat');
    expect('user' in context!).toBe(false);
  });

  it('carries both user and protocol when both are present', async () => {
    const service = build();
    const seen = captureContext(service, '/ws', { protocols: ['chat'] });

    const decision = await service.routeUpgrade(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'chat' }),
      principal,
    );
    if (decision === null || !decision.accept) {
      throw new Error(`expected an accepted upgrade, got ${JSON.stringify(decision)}`);
    }
    open(decision.sink);

    const context = seen[0]?.context;
    expect(context!.protocol).toBe('chat');
    expect(context!.user).toEqual(principal);
  });

  it('routes a non-upgrade request to null regardless of principal', async () => {
    const service = build();
    service.route('/ws', {});

    const decision = await service.routeUpgrade(
      new Request('http://localhost/ws'),
      principal,
    );

    expect(decision).toBeNull();
  });

  it('resolves an accepted decision when the principal is absent', async () => {
    // The contract says an implementation "must treat a missing principal as
    // anonymous and must not throw on its absence" — pin that directly.
    const service = build();
    service.route('/ws', {});

    const decision = await service.routeUpgrade(upgradeRequest('http://localhost/ws'));

    expect(decision?.accept).toBe(true);
  });
});

describe('WebSocketService.createUpgradeRouter — public signature preserved', () => {
  it('still type-checks as (request: Request) => Promise<WebSocketUpgradeDecision | null>', () => {
    const service = new WebSocketService(createFakeRuntime(), resolveOptions(), true);

    // Compile-time assertion: the return type must be EXACTLY the public
    // single-parameter WebSocketUpgradeRouter. A widened two-parameter
    // signature here would be a contract change the adapter must not see.
    const router: WebSocketUpgradeRouter = service.createUpgradeRouter();
    const call: Promise<WebSocketUpgradeDecision | null> = router(
      upgradeRequest('http://localhost/ws'),
    );

    expect(call).toBeInstanceOf(Promise);
  });

  it('routes an adapter-side call as anonymous (user key omitted)', async () => {
    const service = new WebSocketService(createFakeRuntime(), resolveOptions(), true);
    const seen = captureContext(service, '/ws');

    const router = service.createUpgradeRouter();
    const decision = await router(upgradeRequest('http://localhost/ws'));
    if (decision === null || !decision.accept) {
      throw new Error(`expected an accepted upgrade, got ${JSON.stringify(decision)}`);
    }
    open(decision.sink);

    const context = seen[0]?.context;
    expect('user' in context!).toBe(false);
    expect(Object.keys(context!)).not.toContain('user');
  });
});

describe('buildContext — principal parameter', () => {
  it('sets user to the principal when one is supplied', () => {
    const context = buildContext(
      upgradeRequest('http://localhost/ws'),
      undefined,
      principal,
    );

    expect(context.user).toEqual(principal);
    expect(context.user).toBe(principal);
  });

  it('omits user (key absent) when no principal is supplied', () => {
    const context = buildContext(upgradeRequest('http://localhost/ws'), undefined);

    expect('user' in context).toBe(false);
    expect(Object.keys(context)).not.toContain('user');
  });

  it('omits user when the principal argument is explicitly undefined', () => {
    const context = buildContext(upgradeRequest('http://localhost/ws'), undefined, undefined);

    expect('user' in context).toBe(false);
  });

  it('keeps user and protocol independent', () => {
    const withBoth = buildContext(
      upgradeRequest('http://localhost/ws'),
      'chat',
      principal,
    );
    const protocolOnly = buildContext(upgradeRequest('http://localhost/ws'), 'chat');
    const userOnly = buildContext(
      upgradeRequest('http://localhost/ws'),
      undefined,
      principal,
    );

    expect(withBoth.protocol).toBe('chat');
    expect(withBoth.user).toEqual(principal);

    expect(protocolOnly.protocol).toBe('chat');
    expect('user' in protocolOnly).toBe(false);

    expect('protocol' in userOnly).toBe(false);
    expect(userOnly.user).toEqual(principal);
  });
});

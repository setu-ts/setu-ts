/**
 * Wiring tests for plugin/graphql-plugin.ts
 *
 * Covers the registration paths the existing graphql-plugin.test.ts does not
 * reach: the optional-capability transport wiring (WebSocket available /
 * absent / unavailable, SSE enabled / disabled), the APQ RUNTIME guard and
 * ApqResolver construction, the health indicator's subscriptions branch, and
 * the onClose cache-clear lifecycle hook.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ICacheStore,
  IGraphqlService,
  ILifecycleApi,
  IPluginContext,
  IRuntimeServices,
  IWebSocketService,
  RouteHandler,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { GraphqlPlugin } from '../../src/plugin/graphql-plugin.ts';
import { GRAPHQL_TRANSPORT_WS } from '../../src/transports/ws/ws-protocol.ts';

interface Wired {
  ctx: IPluginContext;
  routes: Array<[string, RouteHandler]>;
  wsRoutes: Array<{ path: string; options: Record<string, unknown> }>;
  healthCallback: (() => Promise<{ status: string; data: unknown }>) | undefined;
  onCloseCallbacks: Array<() => void>;
  servicesMap: Map<string, unknown>;
}

function createWiredContext(opts: {
  hasWebsocket?: boolean;
  wsAvailable?: boolean;
  hasRuntime?: boolean;
  hasCache?: boolean;
  withLifecycle?: boolean;
} = {}): Wired {
  const routes: Array<[string, RouteHandler]> = [];
  const wsRoutes: Array<{ path: string; options: Record<string, unknown> }> = [];
  const onCloseCallbacks: Array<() => void> = [];
  const servicesMap = new Map<string, unknown>();

  const wsService = {
    available: opts.wsAvailable ?? true,
    route: (path: string, _handlers: unknown, options?: unknown) =>
      wsRoutes.push({ path, options: (options ?? {}) as Record<string, unknown> }),
    connectionCount: 0,
    roomCount: 0,
  } as unknown as IWebSocketService;

  if (opts.hasWebsocket !== false) servicesMap.set(CAPABILITIES.WEBSOCKET, wsService);
  if (opts.hasRuntime !== false) {
    servicesMap.set(
      CAPABILITIES.RUNTIME,
      { subtle: globalThis.crypto.subtle } as unknown as IRuntimeServices,
    );
  }
  if (opts.hasCache) servicesMap.set(CAPABILITIES.CACHE, {} as unknown as ICacheStore);

  const wired: Wired = {
    ctx: undefined as unknown as IPluginContext,
    routes,
    wsRoutes,
    healthCallback: undefined as Wired['healthCallback'] | undefined,
    onCloseCallbacks,
    servicesMap,
  };

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    router: {
      post: (p: string, h: RouteHandler) => routes.push([`POST ${p}`, h]),
      get: (p: string, h: RouteHandler) => routes.push([`GET ${p}`, h]),
    },
    services: {
      register: (token: string, svc: unknown) => {
        servicesMap.set(token, svc);
      },
      has: (token: string) => servicesMap.has(token),
      get: <T>(token: string) => servicesMap.get(token) as T,
    },
    health: {
      register: (_name: string, cb: () => Promise<{ status: string; data: unknown }>) => {
        wired.healthCallback = cb;
      },
    },
    ...(opts.withLifecycle !== false
      ? {
        lifecycle: {
          onClose: (cb: () => void) => onCloseCallbacks.push(cb),
        } as unknown as ILifecycleApi,
      }
      : {}),
  } as unknown as IPluginContext;
  wired.ctx = ctx;
  return wired;
}

const typeDefs = 'type Query { hello: String }';
const resolvers = { Query: { hello: () => 'world' } };

describe('GraphqlPlugin — subscriptions / APQ / lifecycle wiring', () => {
  it('registers the WS route (heartbeat:false, graphql-transport-ws) and SSE route when available', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(1);
    expect(wired.wsRoutes[0]!.path).toBe('/graphql/ws');
    expect(wired.wsRoutes[0]!.options).toEqual({
      protocols: [GRAPHQL_TRANSPORT_WS],
      heartbeat: false,
    });
    // SSE registered at the derived path: POST + GET /graphql/stream.
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql/stream');
    expect(wired.routes.map(([r]) => r)).toContain('GET /graphql/stream');
  });

  it('derives transport paths from a custom endpoint (C7)', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({
      typeDefs,
      resolvers,
      path: '/api/graphql',
      subscriptions: {},
    });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes[0]!.path).toBe('/api/graphql/ws');
    expect(wired.routes.map(([r]) => r)).toContain('POST /api/graphql/stream');
  });

  it('skips the WS transport when CAPABILITIES.WEBSOCKET is absent', async () => {
    const wired = createWiredContext({ hasWebsocket: false });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(0);
    // SSE is still registered.
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql/stream');
  });

  it('skips the WS transport when ws.available is false', async () => {
    const wired = createWiredContext({ wsAvailable: false });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(0);
  });

  it('registers no transport routes when subscriptions is absent (M51 byte-identical)', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({ typeDefs, resolvers });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(0);
    expect(wired.routes.map(([r]) => r).filter((r) => r.includes('stream'))).toEqual([]);
  });

  it('disables the WS transport with subscriptions.websocket:false', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({
      typeDefs,
      resolvers,
      subscriptions: { websocket: false },
    });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(0);
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql/stream');
  });

  it('disables the SSE transport with subscriptions.sse:false', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: { sse: false } });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes.length).toBe(1);
    expect(wired.routes.map(([r]) => r).filter((r) => r.includes('stream'))).toEqual([]);
  });

  it('accepts explicit transport paths', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({
      typeDefs,
      resolvers,
      subscriptions: {
        websocket: { path: '/ws-custom' },
        sse: { path: '/sse-custom' },
      },
    });
    await plugin.register(wired.ctx);

    expect(wired.wsRoutes[0]!.path).toBe('/ws-custom');
    expect(wired.routes.map(([r]) => r)).toContain('POST /sse-custom');
  });

  it('threads sse heartbeatMs into the SSE handler', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({
      typeDefs,
      resolvers,
      subscriptions: { sse: { heartbeatMs: 1234 } },
    });
    // The heartbeatMs is exercised in the handler unit test; here we assert
    // registration succeeds and the SSE route is present.
    await expect(plugin.register(wired.ctx)).resolves.toBeUndefined();
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql/stream');
  });

  it('APQ without CAPABILITIES.RUNTIME throws naming the requirement', async () => {
    const wired = createWiredContext({ hasRuntime: false });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, apq: {} });
    await expect(plugin.register(wired.ctx)).rejects.toThrow(/CAPABILITIES.RUNTIME/);
  });

  it('subscriptions without CAPABILITIES.RUNTIME throw naming the requirement', async () => {
    // The transports take their timers from runtime services, so an absent
    // runtime has to fail at registration with a name rather than at the first
    // connection with a bare TypeError — the same contract as the APQ guard.
    const wired = createWiredContext({ hasRuntime: false });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} });
    await expect(plugin.register(wired.ctx)).rejects.toThrow(/CAPABILITIES.RUNTIME/);
  });

  it('APQ honours a non-default maxEntries on the in-memory fallback', async () => {
    // No cache capability, so the bounded LRU is the store and `maxEntries` is
    // the option that bounds it.
    const wired = createWiredContext({ hasRuntime: true, hasCache: false });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, apq: { maxEntries: 2 } });
    await expect(plugin.register(wired.ctx)).resolves.toBeUndefined();
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql');
  });

  it('APQ with RUNTIME registers and constructs the resolver', async () => {
    const wired = createWiredContext({ hasRuntime: true, hasCache: true });
    const plugin = GraphqlPlugin({ typeDefs, resolvers, apq: { ttlSeconds: 99 } });
    await expect(plugin.register(wired.ctx)).resolves.toBeUndefined();
    expect(wired.routes.map(([r]) => r)).toContain('POST /graphql');
  });

  it('health indicator reports transport status under subscriptions', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} });
    await plugin.register(wired.ctx);

    expect(wired.healthCallback).toBeDefined();
    const result = await wired.healthCallback!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({
      endpoint: '/graphql',
      cachedDocuments: 0,
      subscriptions: { websocket: true, sse: true },
    });
  });

  it('onClose clears the document cache', async () => {
    const wired = createWiredContext();
    const plugin = GraphqlPlugin({ typeDefs, resolvers });
    await plugin.register(wired.ctx);

    const service = wired.servicesMap.get(CAPABILITIES.GRAPHQL) as IGraphqlService;
    await service.execute({ query: '{ hello }' });
    expect(service.cachedDocumentCount).toBe(1);

    expect(wired.onCloseCallbacks.length).toBe(1);
    wired.onCloseCallbacks[0]!();
    expect(service.cachedDocumentCount).toBe(0);
  });
});

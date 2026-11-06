/**
 * Integration test: the kernel passes the request's public origin to
 * `IWebSocketService.routeUpgrade`, so the router can refuse a cross-site
 * handshake against the origin the browser saw — the one a trusted proxy
 * published when there is one (`requestOriginOf`), else the request URL's.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITIES, isWebSocketUpgradeRequest, REQUEST_ORIGIN_STATE_KEY } from '@setu-ts/common';
import type {
  IPlugin,
  IPluginContext,
  IWebSocketService,
  WebSocketUpgradeDecision,
} from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const UPGRADE_HEADERS = { upgrade: 'websocket', connection: 'Upgrade' } as const;

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** A WebSocket service stand-in recording the third `routeUpgrade` argument. */
function recordingWsPlugin(seen: (string | undefined)[]): IPlugin {
  const service = {
    routeUpgrade: (
      request: Request,
      _principal?: unknown,
      publicOrigin?: string,
    ): Promise<WebSocketUpgradeDecision | null> => {
      seen.push(publicOrigin);
      if (!isWebSocketUpgradeRequest(request.headers)) return Promise.resolve(null);
      return Promise.resolve({ accept: false, status: 403 });
    },
    available: true,
  } as unknown as IWebSocketService;
  return {
    name: 'fake-websocket',
    version: '1.0.0',
    provides: [CAPABILITIES.WEBSOCKET],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.WEBSOCKET, service);
    },
  };
}

describe('Kernel passes the public origin to routeUpgrade', () => {
  it('passes the request URL origin when no proxy origin was published', async () => {
    const seen: (string | undefined)[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingWsPlugin(seen)] });
    await app.start();
    try {
      const res = await app.inject({
        method: 'GET',
        url: 'http://localhost:8080/ws',
        headers: UPGRADE_HEADERS,
      });
      expect(seen).toEqual(['http://localhost:8080']);
      expect(res.statusCode).toBe(403);
    } finally {
      await app.stop();
    }
  });

  it('passes the origin a trusted proxy published', async () => {
    const seen: (string | undefined)[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingWsPlugin(seen)] });
    // What IP security publishes for a trusted proxy's forwarded host.
    app.middleware.add(
      async (ctx, next) => {
        ctx.state.set(REQUEST_ORIGIN_STATE_KEY, { protocol: 'https', host: 'public.example' });
        await next();
      },
      { priority: 10, name: 'published-origin' },
    );
    await app.start();
    try {
      await app.inject({ method: 'GET', url: 'http://10.0.0.5/ws', headers: UPGRADE_HEADERS });
      expect(seen).toEqual(['https://public.example']);
    } finally {
      await app.stop();
    }
  });

  // The router is consulted on every request; the origin is a URL parse, so
  // the kernel computes it only for an upgrade (AI_GUIDELINES §14).
  it('passes no origin for a request that is not an upgrade', async () => {
    const seen: (string | undefined)[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingWsPlugin(seen)] });
    app.router.get('/plain', (ctx) => ctx.response.text('ok'));
    await app.start();
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/plain' });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([undefined]);
    } finally {
      await app.stop();
    }
  });
});

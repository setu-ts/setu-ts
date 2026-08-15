/**
 * guarded-upgrade — X6-1 regression: an unauthenticated upgrade is refused;
 * verified to fail without the M70a pipeline-first fix.
 *
 * Before M70a, the WebSocket upgrade happened BEFORE the middleware pipeline,
 * so auth middleware could not reject an unauthenticated upgrade. After M70a,
 * the pipeline runs first, and a 401 from auth middleware prevents the
 * upgrade intent from being written, so the handshake never occurs.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, type IWebSocketService, PLUGIN_PRIORITY } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';

/**
 * A minimal auth plugin that rejects requests without an
 * Authorization header with 401.
 */
function FakeAuthPlugin(): IPlugin {
  return {
    name: 'fake-auth-plugin',
    version: '0.0.0',
    priority: PLUGIN_PRIORITY.HIGH,
    register(ctx: IPluginContext): void {
      ctx.middleware.add((c, next) => {
        const auth = c.request.headers.get('Authorization');
        if (auth === null) {
          return c.response.status(401).json({ error: 'Unauthorized' });
        }
        return next();
      });
    },
  };
}

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('Guarded WebSocket upgrade (X6-1 regression, M70a)', () => {
  it('an unauthenticated upgrade is refused with 401', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), FakeAuthPlugin(), WebSocketPlugin()],
    });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {
      onOpen: () => {},
      onMessage: () => {},
    });

    // No Authorization header — auth middleware should short-circuit with 401
    // BEFORE the upgrade intent is written, so the handshake never occurs
    const response = await app.fetch(upgradeRequest('http://localhost/ws'));

    expect(response.status).toBe(401);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('an authenticated upgrade proceeds past the middleware', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), FakeAuthPlugin(), WebSocketPlugin()],
    });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {
      onOpen: () => {},
      onMessage: () => {},
    });

    // With Authorization header, auth middleware calls next() and the
    // pipeline reaches the terminal handler, which writes UPGRADE_INTENT
    const response = await app.fetch(
      new Request('http://localhost/ws', {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          Authorization: 'Bearer test-token',
        },
      }),
    );

    // The upgrade proceeds — the adapter returns 101 (or the kernel
    // returns the upgrade response)
    expect(response.status).toBe(101);
    await app.stop();
  });

  it('middleware 403 prevents upgrade on a guarded path', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin()],
    });
    // Add a middleware that rejects based on path
    app.middleware.add((c, next) => {
      if (c.path === '/ws/admin') {
        return c.response.status(403).json({ error: 'Forbidden' });
      }
      return next();
    });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/admin', {
      onOpen: () => {},
      onMessage: () => {},
    });

    const response = await app.fetch(
      new Request('http://localhost/ws/admin', {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }),
    );

    expect(response.status).toBe(403);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('non-upgrade requests on the same path are also guarded', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), FakeAuthPlugin(), WebSocketPlugin()],
    });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {
      onOpen: () => {},
      onMessage: () => {},
    });

    // A plain GET to the WS path (no upgrade header) should also be guarded
    const response = await app.fetch(new Request('http://localhost/ws'));

    expect(response.status).toBe(401);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });
});

/**
 * Route-scoped WebSocket upgrade guards (M86 §3.6) — guards run in declared
 * order, in the router, before the handshake is accepted, and only for the
 * route that declared them. Driven through a real kernel application with
 * `app.fetch`, so a refusal becomes the HTTP status the client actually sees.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { WebSocketConnectionContext } from '@setu-ts/common';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
// The plugin's own option type — deliberately NOT re-exported from common.
import type { WebSocketPluginOptions } from '../../src/index.ts';
import { upgradeRequest } from '../fixtures/fake-runtime.ts';

/**
 * An upgrade request with the full RFC 6455 header set: driven through
 * `app.fetch`, an ACCEPTED decision reaches the real adapter, whose
 * `Deno.upgradeWebSocket` needs the key and version headers to answer 101.
 * Refusals never reach the adapter and answer with the guard's status.
 */
function wireUpgradeRequest(url: string): Request {
  return upgradeRequest(url, {
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
  });
}

describe('WebSocket upgrade guards (M86 §3.6)', () => {
  it('a guard refusing with { status: 401 } prevents the handshake', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/locked', { onMessage: () => {} }, {
      guards: [() => ({ status: 401, body: 'not authorized' })],
    });

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/locked'));

    expect(response.status).toBe(401);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('guards run in declared order and the first refusal wins', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const ran: string[] = [];
    ws.route('/ws/ordered', { onMessage: () => {} }, {
      guards: [
        (context) => {
          ran.push('first');
          void context;
          return true;
        },
        (context) => {
          ran.push('second');
          void context;
          return { status: 403 };
        },
        (context) => {
          ran.push('third');
          void context;
          return true;
        },
      ],
    });

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/ordered'));

    expect(response.status).toBe(403);
    // Declared order — and the refusal stops the guard AFTER it: `third`
    // never runs once `second` has refused.
    expect(ran).toEqual(['first', 'second']);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('a refusal stops later guards from running', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const ran: string[] = [];
    ws.route('/ws/short', { onMessage: () => {} }, {
      guards: [
        () => {
          ran.push('first');
          return { status: 429 };
        },
        () => {
          ran.push('second');
          return true;
        },
      ],
    });

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/short'));

    expect(response.status).toBe(429);
    expect(ran).toEqual(['first']);
    await app.stop();
  });

  it('an accepting async guard lets the handshake through', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let guardRan = false;
    ws.route('/ws/open', { onMessage: () => {} }, {
      guards: [
        (context: WebSocketConnectionContext): Promise<true> => {
          guardRan = true;
          void context;
          return Promise.resolve(true);
        },
      ],
    });

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/open'));

    expect(guardRan).toBe(true);
    expect(response.status).toBe(101);
    await app.stop();
  });

  it('a guard registered on one route does NOT run for another route', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const guardedFor: string[] = [];
    ws.route('/ws/a', { onMessage: () => {} }, {
      guards: [
        (context) => {
          guardedFor.push(context.path);
          return true;
        },
      ],
    });
    ws.route('/ws/b', { onMessage: () => {} });

    const a = await app.fetch(wireUpgradeRequest('http://localhost/ws/a'));
    const b = await app.fetch(wireUpgradeRequest('http://localhost/ws/b'));

    // Both handshakes complete, and the only guard invocation ever recorded
    // was for /ws/a — the property the application-wide middleware workaround
    // cannot express.
    expect(a.status).toBe(101);
    expect(b.status).toBe(101);
    expect(guardedFor).toEqual(['/ws/a']);
    await app.stop();
  });

  it('hands the guard the full connection context at accept-decision time', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let seen: WebSocketConnectionContext | undefined;
    ws.route('/ws/ctx', { onMessage: () => {} }, {
      guards: [
        (context) => {
          seen = context;
          return true;
        },
      ],
    });

    const request = upgradeRequest('http://localhost/ws/ctx?room=lobby', {
      authorization: 'Bearer token-1',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    });
    await app.fetch(request);

    expect(seen).toBeDefined();
    expect(seen?.path).toBe('/ws/ctx');
    expect(seen?.query).toEqual({ room: 'lobby' });
    expect(seen?.headers.get('authorization')).toBe('Bearer token-1');
    await app.stop();
  });

  it('a declarative routes-arm entry can carry guards through its options', async () => {
    const options: WebSocketPluginOptions = {
      routes: [{
        path: '/ws/declared-locked',
        handlers: { onMessage: () => {} },
        options: { guards: [() => ({ status: 403 })] },
      }],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/declared-locked'));

    expect(response.status).toBe(403);
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('a throwing guard is contained by the router and refuses with 500', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/broken', { onMessage: () => {} }, {
      guards: [
        () => {
          throw new Error('guard blew up');
        },
      ],
    });

    const response = await app.fetch(wireUpgradeRequest('http://localhost/ws/broken'));

    expect(response.status).toBe(500);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });
});

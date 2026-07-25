/**
 * Integration tests — the plugin wired into a real kernel application, with
 * the real RuntimePlugin and the real Deno HTTP adapter, driven through
 * `app.fetch` rather than a socket.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES, type IWebSocketService } from '@hono-enterprise/common';
import { WebSocketPlugin } from '../../src/index.ts';

describe('WebSocketPlugin integration', () => {
  it('resolves the service from the WEBSOCKET capability token', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    expect(ws.available).toBe(true);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('throws at startup when the plugin is registered twice', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin(), WebSocketPlugin()],
    });

    await expect(app.start()).rejects.toThrow();
  });

  it('leaves ordinary HTTP requests entirely untouched', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    app.router.get('/hello', (ctx) => ctx.response.json({ hello: 'world' }));
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    const response = await app.fetch(new Request('http://localhost/hello'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: 'world' });
    await app.stop();
  });

  it('does not treat a plain GET on a WebSocket path as an upgrade', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    // No Upgrade header, so the router is never consulted and the request
    // falls through to the HTTP pipeline, which has no such route.
    const response = await app.fetch(new Request('http://localhost/ws'));

    expect(response.status).toBe(404);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('refuses a duplicate WebSocket route registration', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    expect(() => ws.route('/ws', {})).toThrow('already registered');
    await app.stop();
  });

  it('shares rooms across routes through the single registered service', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const fromFirst = ws.room('shared');
    const fromSecond = app.services
      .get<IWebSocketService>(CAPABILITIES.WEBSOCKET)
      .room('shared');

    expect(fromFirst).toBe(fromSecond);
    await app.stop();
  });
});

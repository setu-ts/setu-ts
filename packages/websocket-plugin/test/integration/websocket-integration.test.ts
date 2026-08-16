/**
 * Integration tests — the plugin wired into a real kernel application, with
 * the real RuntimePlugin and the real Deno HTTP adapter, driven through
 * `app.fetch` rather than a socket.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { ILogger, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, type IWebSocketService, PLUGIN_PRIORITY } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
import { createFakeLogger, requestFailingOnSecondHeaderRead } from '../fixtures/fake-runtime.ts';

/** A minimal plugin that publishes a capturing logger under the logger token. */
function FakeLoggerPlugin(logger: ILogger): IPlugin {
  return {
    name: 'fake-logger-plugin',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    priority: PLUGIN_PRIORITY.HIGH,
    register(ctx: IPluginContext): void {
      ctx.services.register<ILogger>(CAPABILITIES.LOGGER, logger);
    },
  };
}

describe('WebSocketPlugin integration', () => {
  it('resolves the service from the WEBSOCKET capability token', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    expect(ws.available).toBe(true);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('reports an upgrade-router failure through the registered logger', async () => {
    // Proves the plugin really hands ctx.logger to the service: without that
    // wiring the cause is swallowed by the adapter backstop and nothing is
    // ever written anywhere.
    const logger = createFakeLogger();
    const app = createApplication({
      plugins: [RuntimePlugin(), FakeLoggerPlugin(logger), WebSocketPlugin()],
    });
    await app.start();
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    const response = await app.fetch(requestFailingOnSecondHeaderRead('http://localhost/ws'));

    expect(response.status).toBe(500);
    // Two entries, in order: the startup scaling notice (no backplane is
    // registered here), then the upgrade failure this test is about.
    expect(logger.entries.map((entry) => entry.level)).toEqual(['info', 'error']);
    expect(logger.entries[0].message).toContain('rooms broadcast in-process only');
    expect(logger.entries[1].message).toBe('WebSocket upgrade routing failed');
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

    // No Upgrade header, so the router declines and the request falls through
    // to the HTTP pipeline, which has no such route. `WsRouteTable.match` keys
    // on PATH ALONE, so without the RFC 6455 header check in
    // `WebSocketService.#route` this plain GET would be upgraded.
    const response = await app.fetch(new Request('http://localhost/ws'));

    expect(response.status).toBe(404);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('does not treat "no-upgrade" in Connection as an upgrade token', async () => {
    // A substring match on the `Connection` header would claim this request.
    // RFC 6455 §4.2.1 asks for the `upgrade` TOKEN, so the shared predicate
    // splits on commas and compares whole tokens.
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    const response = await app.fetch(
      new Request('http://localhost/ws', {
        headers: { upgrade: 'websocket', connection: 'no-upgrade' },
      }),
    );

    expect(response.status).toBe(404);
    expect(ws.connectionCount).toBe(0);
    await app.stop();
  });

  it('upgrades when Connection carries the token among others, as proxies send', async () => {
    // The control for the two tests above: `keep-alive, Upgrade` is what a
    // proxy actually forwards, and it MUST still upgrade.
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', {});

    const response = await app.fetch(
      new Request('http://localhost/ws', {
        headers: {
          upgrade: 'websocket',
          connection: 'keep-alive, Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      }),
    );

    expect(response.status).toBe(101);
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

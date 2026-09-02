/**
 * Frame behaviours (M86 §3.7/§3.9/§3.11) — the plugin-level behaviour chain
 * around `onMessage`: envelope shape, declared order, short-circuit, error
 * routing, and arrival-order preservation under a chain. Driven through a
 * real kernel application, so the behaviours are the ones the plugin's
 * `onInit` hook actually installed.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type {
  IIngressBehavior,
  IngressContext,
  IWebSocketConnection,
  IWebSocketService,
  WebSocketEventSink,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
// The plugin's own option type — deliberately NOT re-exported from common.
import type { WebSocketPluginOptions } from '../../src/index.ts';
import { createFakeTransport, upgradeRequest } from '../fixtures/fake-runtime.ts';

/** A configurable recorder behaviour shared by the tests below. */
function behavior(
  log: string[],
  label: string,
  mode: 'next' | 'short-circuit' | 'throw' | 'defer' = 'next',
): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      if (mode === 'short-circuit') {
        return;
      }
      if (mode === 'throw') {
        throw new Error(`${label} exploded`);
      }
      if (mode === 'defer') {
        return Promise.resolve().then(() => next());
      }
      return next();
    },
  };
}

/** Upgrades through the service and binds a fake transport into the sink. */
async function connect(ws: IWebSocketService, path: string): Promise<WebSocketEventSink> {
  const decision = await ws.routeUpgrade!(upgradeRequest(`http://localhost${path}`));
  if (decision?.accept !== true) {
    throw new Error(`upgrade for ${path} was refused`);
  }
  decision.sink.onOpen(createFakeTransport());
  return decision.sink;
}

describe('WebSocket frame behaviours (M86 §3.7)', () => {
  it('a behaviour observes the ingress envelope and the handler still runs', async () => {
    const envelopes: IngressContext[] = [];
    const options: WebSocketPluginOptions = {
      behaviors: [{
        handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
          envelopes.push(ctx);
          return next();
        },
      }],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let openConn: IWebSocketConnection | undefined;
    let messageConn: IWebSocketConnection | undefined;
    let received: string | Uint8Array | undefined;
    ws.route('/ws/echo', {
      onOpen: (conn) => {
        openConn = conn;
      },
      onMessage: (conn, data) => {
        messageConn = conn;
        received = data;
      },
    });

    const sink = await connect(ws, '/ws/echo');
    sink.onMessage('hello');
    await Promise.resolve();

    // Exact envelope shape: kind names the ingress, name is the ROUTE PATH,
    // payload is the raw frame — and nothing else (no fabricated attempt,
    // no headers channel on this arm).
    expect(envelopes).toEqual([
      { kind: 'websocket', name: '/ws/echo', payload: 'hello' },
    ]);
    expect(received).toBe('hello');
    expect(messageConn).toBe(openConn);
    await app.stop();
  });

  it('runs behaviours in declared order, behaviours[0] first, ahead of the handler', async () => {
    const log: string[] = [];
    const options: WebSocketPluginOptions = {
      behaviors: [behavior(log, 'first'), behavior(log, 'second'), behavior(log, 'third')],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/ordered', {
      onMessage: () => {
        log.push('handler');
      },
    });

    const sink = await connect(ws, '/ws/ordered');
    sink.onMessage('frame');
    await Promise.resolve();

    expect(log).toEqual(['first', 'second', 'third', 'handler']);
    await app.stop();
  });

  it('a short-circuiting behaviour prevents onMessage from ever seeing the frame', async () => {
    const log: string[] = [];
    const options: WebSocketPluginOptions = {
      behaviors: [behavior(log, 'gate', 'short-circuit'), behavior(log, 'never', 'throw')],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let handlerRan = false;
    ws.route('/ws/gated', {
      onMessage: () => {
        handlerRan = true;
      },
    });

    const sink = await connect(ws, '/ws/gated');
    sink.onMessage('frame');
    await Promise.resolve();

    expect(log).toEqual(['gate']);
    expect(handlerRan).toBe(false);
    await app.stop();
  });

  it('a behaviour throw reaches onError rather than becoming an unhandled rejection', async () => {
    const options: WebSocketPluginOptions = {
      behaviors: [behavior([], 'broken', 'throw')],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let handlerRan = false;
    let reported: Error | undefined;
    ws.route('/ws/failing', {
      onMessage: () => {
        handlerRan = true;
      },
      onError: (_conn, error) => {
        reported = error;
      },
    });

    const sink = await connect(ws, '/ws/failing');
    sink.onMessage('frame');
    await Promise.resolve();

    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toBe('broken exploded');
    expect(handlerRan).toBe(false);
    await app.stop();
  });

  it('a synchronous handler still observes frames in arrival order under a chain', async () => {
    const log: string[] = [];
    const options: WebSocketPluginOptions = {
      behaviors: [behavior(log, 'chain')],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const received: string[] = [];
    ws.route('/ws/ordered-frames', {
      onMessage: (_conn, data) => {
        received.push(String(data));
      },
    });

    const sink = await connect(ws, '/ws/ordered-frames');
    // Three frames dispatched back-to-back; a synchronous handler must see
    // them in arrival order through the chain (M86 §3.11).
    sink.onMessage('a');
    sink.onMessage('b');
    sink.onMessage('c');

    expect(received).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['chain', 'chain', 'chain']);
    await app.stop();
  });

  it('dispatch becomes promise-mediated: a deferring behaviour delays the handler', async () => {
    const options: WebSocketPluginOptions = {
      behaviors: [behavior([], 'deferred', 'defer')],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let handlerRan = false;
    ws.route('/ws/deferred', {
      onMessage: () => {
        handlerRan = true;
      },
    });

    const sink = await connect(ws, '/ws/deferred');
    sink.onMessage('frame');

    // The chain is promise-mediated: the handler has NOT run when dispatch
    // returns, unlike the zero-configuration path.
    expect(handlerRan).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(handlerRan).toBe(true);
    await app.stop();
  });

  it('resolves behaviours declared as RegistryFactory entries in onInit', async () => {
    let factoryRan = false;
    const options: WebSocketPluginOptions = {
      behaviors: [
        () => {
          factoryRan = true;
          return behavior([], 'from-registry');
        },
      ],
    };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    // `start()` ran the plugin's onInit hook, which resolved the factory.
    expect(factoryRan).toBe(true);

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let handlerRan = false;
    ws.route('/ws/factory-behavior', {
      onMessage: () => {
        handlerRan = true;
      },
    });

    const sink = await connect(ws, '/ws/factory-behavior');
    sink.onMessage('frame');
    await Promise.resolve();

    expect(handlerRan).toBe(true);
    await app.stop();
  });

  it('ships no route-level behaviors arm — guards are the per-route mechanism', async () => {
    const options: WebSocketPluginOptions = { behaviors: [behavior([], 'plugin-level')] };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    // Compile-time proof that `WebSocketRouteOptions` carries no `behaviors`
    // member (M86 §3.7): the directive is self-validating — adding the arm
    // makes this a compile error.
    ws.route(
      '/ws/no-route-arm',
      { onMessage: () => {} },
      // @ts-expect-error — WebSocketRouteOptions deliberately has no behaviors arm
      { behaviors: [] },
    );

    const decision = await ws.routeUpgrade!(upgradeRequest('http://localhost/ws/no-route-arm'));
    expect(decision?.accept).toBe(true);
    await app.stop();
  });
});

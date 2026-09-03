/**
 * No-options-unchanged (M86 §3.9/§3.11) — with no behaviours configured, frame
 * dispatch is byte-identical to the pre-chain behaviour: `onMessage` is
 * invoked SYNCHRONOUSLY with the identical `(conn, data)` arguments, no chain
 * sits in front of it, and the rejection path to `onError` is unchanged.
 *
 * The synchronicity is asserted by observing the handler ran before the next
 * statement — the observable form of "no chain" — not by reading a private
 * field, which a refactor could silently invalidate.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IWebSocketConnection, IWebSocketService, WebSocketEventSink } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
// The plugin's own option type — deliberately NOT re-exported from common.
import type { WebSocketPluginOptions } from '../../src/index.ts';
import { createFakeTransport, upgradeRequest } from '../fixtures/fake-runtime.ts';

async function connect(ws: IWebSocketService, path: string): Promise<WebSocketEventSink> {
  const decision = await ws.routeUpgrade!(upgradeRequest(`http://localhost${path}`));
  if (decision?.accept !== true) {
    throw new Error(`upgrade for ${path} was refused`);
  }
  decision.sink.onOpen(createFakeTransport());
  return decision.sink;
}

describe('WebSocket zero-configuration dispatch is unchanged (M86 §3.9)', () => {
  it('invokes onMessage synchronously with the identical (conn, data) arguments', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let openConn: IWebSocketConnection | undefined;
    let ran = false;
    let seenConn: IWebSocketConnection | undefined;
    let seenData: string | Uint8Array | undefined;
    ws.route('/ws/plain', {
      onOpen: (conn) => {
        openConn = conn;
      },
      onMessage: (conn, data) => {
        ran = true;
        seenConn = conn;
        seenData = data;
      },
    });

    const sink = await connect(ws, '/ws/plain');
    sink.onMessage('frame-1');

    // Ran BEFORE the next statement — the synchronous, unchained dispatch.
    expect(ran).toBe(true);
    expect(seenData).toBe('frame-1');
    expect(seenConn).toBe(openConn);
    await app.stop();
  });

  it('hands a binary frame through untransformed — the same instance the adapter delivered', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let seenData: string | Uint8Array | undefined;
    ws.route('/ws/binary', {
      onMessage: (_conn, data) => {
        seenData = data;
      },
    });

    const sink = await connect(ws, '/ws/binary');
    const frame = new TextEncoder().encode('binary-payload');
    sink.onMessage(frame);

    expect(seenData).toBe(frame);
    await app.stop();
  });

  it('an explicitly empty behaviors arm still dispatches synchronously', async () => {
    const options: WebSocketPluginOptions = { behaviors: [] };
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin(options)] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let ran = false;
    ws.route('/ws/empty-arm', {
      onMessage: () => {
        ran = true;
      },
    });

    const sink = await connect(ws, '/ws/empty-arm');
    sink.onMessage('frame');

    // An empty array is NOT "at least one behaviour": the direct path wins.
    expect(ran).toBe(true);
    await app.stop();
  });

  it('routes an async handler rejection to onError exactly as before', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    let reported: Error | undefined;
    ws.route('/ws/rejecting', {
      onMessage: (): Promise<void> => Promise.reject(new Error('handler failed')),
      onError: (_conn, error) => {
        reported = error;
      },
    });

    const sink = await connect(ws, '/ws/rejecting');
    sink.onMessage('frame');
    await Promise.resolve();

    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toBe('handler failed');
    await app.stop();
  });
});

/**
 * The whole path, end to end: two kernel applications, each with its own
 * `CloudflarePlugin` durableObject arm over ONE shared Durable Object namespace,
 * plus the real `WebSocketPlugin`.
 *
 * This is the test that proves the wiring rather than the pieces. The
 * integration tests show the backplane carries a frame; this shows that the
 * token `CloudflarePlugin` registers is the token `websocket-plugin` resolves —
 * which is the actual deliverable, and the one thing a mismatch would silently
 * break while every other test stayed green.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IApplication,
  IRealtimeBackplane,
  IWebSocketConnection,
  IWebSocketService,
} from '@hono-enterprise/common';

import { CloudflarePlugin } from '../../src/index.ts';
import { FakeDurableObjectNamespace } from '../do-fakes.ts';

/**
 * A connection standing in for a browser attached to one replica.
 *
 * Every member of the committed `IWebSocketConnection` is supplied, and `isOpen`
 * in particular is load-bearing: `Room.broadcastLocal` DROPS any member
 * reporting `isOpen === false`, so a double that omitted it would be evicted
 * before delivery and the test would pass vacuously against no members at all.
 */
function fakeConnection(id: string, received: (string | Uint8Array)[]): IWebSocketConnection {
  return {
    id,
    path: '/ws',
    readyState: 'open',
    isOpen: true,
    data: new Map<string, unknown>(),
    send(data: string | Uint8Array): void {
      received.push(data);
    },
    sendJson<T>(payload: T): void {
      received.push(JSON.stringify(payload));
    },
    close(): void {},
  } as IWebSocketConnection;
}

/** Builds one replica over the shared namespace. */
async function replica(namespace: FakeDurableObjectNamespace): Promise<IApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      CloudflarePlugin({
        env: { REALTIME: namespace },
        durableObject: { binding: 'REALTIME' },
      }),
      WebSocketPlugin(),
    ],
  });
  await app.start();
  return app;
}

describe('Durable Object backplane end to end, through websocket-plugin', () => {
  it('a room broadcast on one replica reaches a member on the other', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const alpha = await replica(namespace);
    const beta = await replica(namespace);

    const wsAlpha = alpha.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const wsBeta = beta.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    // Each replica must have an open socket to the object before the broadcast;
    // on a live deployment the first publish opens it.
    await alpha.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE).connect();
    await beta.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE).connect();

    const onAlpha: (string | Uint8Array)[] = [];
    const onBeta: (string | Uint8Array)[] = [];
    wsAlpha.room('lobby').add(fakeConnection('conn-alpha', onAlpha));
    wsBeta.room('lobby').add(fakeConnection('conn-beta', onBeta));

    wsAlpha.room('lobby').broadcast('hello lobby');
    // The fan-out crosses the object synchronously in the fake, but the publish
    // itself is a promise the service fires detached.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Local delivery is direct, and always worked.
    expect(onAlpha).toEqual(['hello lobby']);
    // This is the deliverable: without the backplane, beta's member sees
    // nothing, because room membership is per-process.
    expect(onBeta).toEqual(['hello lobby']);

    await alpha.stop();
    await beta.stop();
  });

  it('stays in-process when no backplane is registered, unchanged from before', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const alpha = await replica(namespace);
    // No durableObject arm: the backplane token is absent, and websocket-plugin
    // resolves it optionally.
    const beta = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace } }),
        WebSocketPlugin(),
      ],
    });
    await beta.start();

    const onBeta: (string | Uint8Array)[] = [];
    beta.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET).room('lobby').add(
      fakeConnection('conn-beta', onBeta),
    );
    await alpha.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE).connect();
    alpha.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET).room('lobby').broadcast('hi');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBeta).toEqual([]);

    await alpha.stop();
    await beta.stop();
  });
});

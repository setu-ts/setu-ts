/**
 * A malformed handshake never reaches a Workers route's handlers (V13-278).
 *
 * workerd invokes the Worker before it checks the handshake, so the adapter
 * used to create and accept the socket pair — firing the route's `onOpen`, a
 * room join and a `maxConnections` slot — before the platform answered the
 * client 400 or 426. The adapter now applies the check itself first: version
 * 13 only, as workerd speaks only 13.
 *
 * The check applies to requests from the edge, which workerd marks with `cf`.
 * A Worker-to-Worker subrequest (a service binding or Durable Object stub)
 * carries no `cf` and no key — workerd builds that handshake — so it is not
 * checked and still opens.
 *
 * Driven through a real kernel app on the Workers platform with a fake
 * `WebSocketPair`. Under Node a 101 response cannot be constructed, so without
 * the check the handshake also fails after `onOpen` and runs `onClose`: both
 * phantom calls are what this test refuses.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '../../src/index.ts';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

/** A socket half that accepts and records nothing. */
class FakeSocket {
  readyState = 1;
  accept(): void {}
  send(): void {}
  close(): void {}
  addEventListener(): void {}
}

/** The global the Workers adapter reads, shaped like workerd's. */
class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();
}

/** Each refused case: its headers, the status and the headers the client gets. */
const CASES: readonly {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly expectHeaders: Readonly<Record<string, string>>;
}[] = [
  { name: 'no key', headers: { 'sec-websocket-version': '13' }, status: 400, expectHeaders: {} },
  {
    name: 'a malformed key',
    headers: { 'sec-websocket-key': 'short', 'sec-websocket-version': '13' },
    status: 400,
    expectHeaders: {},
  },
  {
    name: 'version 8, which workerd does not speak',
    headers: { 'sec-websocket-key': KEY, 'sec-websocket-version': '8' },
    status: 426,
    expectHeaders: { 'sec-websocket-version': '13', upgrade: 'websocket' },
  },
  {
    name: 'no version',
    headers: { 'sec-websocket-key': KEY },
    status: 426,
    expectHeaders: { 'sec-websocket-version': '13', upgrade: 'websocket' },
  },
];

/** Marks a request as arriving from the edge, as workerd does with `cf`. */
function fromEdge(request: Request): Request {
  Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
  return request;
}

describe('a malformed handshake on Workers runs no route handler (V13-278)', () => {
  const calls: string[] = [];
  let app: IKernelApplication;
  const globals = globalThis as { WebSocketPair?: unknown };

  beforeAll(async () => {
    globals.WebSocketPair = FakeWebSocketPair;
    app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'cloudflare-workers' }),
        WebSocketPlugin({
          routes: [
            {
              path: '/ws',
              handlers: {
                onOpen: () => {
                  calls.push('open');
                },
                onClose: () => {
                  calls.push('close');
                },
              },
            },
          ],
        }),
      ],
    });
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
    delete globals.WebSocketPair;
  });

  for (const entry of CASES) {
    it(`${entry.name}: ${String(entry.status)}, and neither onOpen nor onClose runs`, async () => {
      calls.length = 0;

      const response = await app.fetch(
        fromEdge(
          new Request('http://worker/ws', {
            headers: { upgrade: 'websocket', connection: 'Upgrade', ...entry.headers },
          }),
        ),
      );

      expect(response.status).toBe(entry.status);
      for (const [name, value] of Object.entries(entry.expectHeaders)) {
        expect(response.headers.get(name)).toBe(value);
      }
      expect(calls).toEqual([]);
    });
  }

  it('a Worker-to-Worker subrequest (no cf, no key) is not refused: the route opens', async () => {
    calls.length = 0;

    // A service binding's `fetch(url, { headers: { Upgrade, Connection } })`.
    // Under Node the 101 cannot be built after the pair is accepted, so the
    // handshake then fails; what matters is that onOpen ran, i.e. no refusal.
    await app.fetch(
      new Request('http://worker/ws', { headers: { upgrade: 'websocket', connection: 'Upgrade' } }),
    );

    expect(calls[0]).toBe('open');
  });

  it("Cloudflare's documented Worker-to-Worker call, Upgrade alone, reaches the route", async () => {
    calls.length = 0;

    // `fetch(url, { headers: { Upgrade: 'websocket' } })` from another Worker:
    // no `cf`, no key, no `Connection: Upgrade`.
    await app.fetch(new Request('http://worker/ws', { headers: { upgrade: 'websocket' } }));

    expect(calls[0]).toBe('open');
  });
});

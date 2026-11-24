/**
 * The server-side arm of a failed WebSocket handshake, on every adapter.
 *
 * A client's malformed handshake gets 400 everywhere (the real-server table in
 * websocket-plugin's `handshake-refusals.test.ts`, and the Workers e2e for
 * workerd, which answers it itself). This file pins the other arm: when the
 * platform cannot complete a handshake the client asked for correctly, Node and
 * Workers answer 500 — the socket machinery failed, not the request — and an
 * adapter whose runtime cannot upgrade on that path answers 501. Measured on
 * the four runtimes on 2026-11-24 (V13-276); Workers keeps its 500 by the
 * maintainer's decision.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { IRequest, IResponse, WebSocketEventSink } from '@setu-ts/common';
import { setUpgradeIntent } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import { BunHttpAdapter, type BunServeHost } from '../../src/adapters/bun/bun-http-adapter.ts';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';
import {
  NodeHttpAdapter,
  NodeHttpServerHandle,
  type NodeServeHost,
} from '../../src/adapters/node/node-http-adapter.ts';
import type { WsModuleLike } from '../../src/adapters/node/node-ws-upgrader.ts';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';
import type { CloudflareWebSocketHost } from '../../src/adapters/workers/cf-ws-upgrader.ts';

/** A correct handshake, so the only fault left is the platform's. */
function handshake(): Request {
  return new Request('http://localhost/ws', {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  });
}

/** A sink recording the close code the adapter reports. */
function recordingSink(codes: number[]): WebSocketEventSink {
  return {
    onOpen() {},
    onMessage() {},
    onError() {},
    onClose(event) {
      codes.push(event.code);
    },
  };
}

/** A handler that brands an upgrade intent, as the kernel's terminal handler does. */
function upgrading(codes: number[]): (request: IRequest) => IResponse {
  return (request) => {
    setUpgradeIntent(request, { sink: recordingSink(codes) });
    return createTestContext().response;
  };
}

/** Node's raw `upgrade` path with a `ws` that throws; resolves with the status line. */
async function nodeRaw(codes: number[]): Promise<number> {
  const wsModule = {
    WebSocketServer: class {
      handleUpgrade(): void {
        throw new Error('ws failed');
      }
      close(): void {}
    },
  } as unknown as WsModuleLike;
  const handle = new NodeHttpServerHandle(wsModule, {});
  handle.setUpgradeRouter(() => Promise.resolve(null));
  const refused = Promise.withResolvers<void>();
  const sink = recordingSink(codes);
  handle.setHandler((request) => {
    setUpgradeIntent(request, {
      sink: {
        ...sink,
        onClose(event) {
          sink.onClose(event);
          refused.resolve();
        },
      },
    });
    return createTestContext().response;
  });
  let listener: ((...args: never[]) => void) | undefined;
  const server = {
    close() {},
    on(_event: string, fn: (...args: never[]) => void) {
      listener = fn;
    },
  };
  handle.attachUpgradeListener(server);
  const written: string[] = [];
  listener!(
    ...([
      {
        url: '/ws',
        headers: {
          host: 'localhost',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      },
      { write: (data: string) => written.push(data), destroy() {} },
      new Uint8Array(),
    ] as unknown as never[]),
  );
  await refused.promise;
  return Number(written.join('').split(' ')[1]);
}

/** One server-side fault: the adapter, the cause, and the status a client gets. */
interface Row {
  readonly runtime: string;
  readonly cause: string;
  readonly status: number;
  readonly run: (codes: number[]) => Promise<number>;
}

const unservedNode: NodeServeHost = {
  serve: () => Promise.resolve({ close: () => {}, on: () => {} }),
};

const ROWS: readonly Row[] = [
  {
    runtime: 'node',
    cause: '`ws` throws during the handshake',
    status: 500,
    run: nodeRaw,
  },
  {
    runtime: 'node',
    cause: 'an upgrade on the fetch path, which has no socket',
    status: 501,
    run: async (codes) => {
      const adapter = new NodeHttpAdapter(unservedNode);
      adapter.setHandler(upgrading(codes));
      return (await adapter.fetch(handshake())).status;
    },
  },
  {
    runtime: 'workers',
    cause: 'the platform cannot create the socket pair',
    status: 500,
    run: async (codes) => {
      const host: CloudflareWebSocketHost = {
        createPair: () => {
          throw new Error('no WebSocketPair');
        },
        createUpgradeResponse: () => new Response(null),
      };
      const adapter = new CloudflareWorkersHttpAdapter(host);
      adapter.setHandler(upgrading(codes));
      return (await adapter.fetch(handshake())).status;
    },
  },
  {
    runtime: 'deno',
    cause: 'the host has no upgradeWebSocket',
    status: 501,
    run: async (codes) => {
      const host: DenoServeHost = { serve: () => ({ shutdown: () => Promise.resolve() }) };
      const adapter = new DenoHttpAdapter(host);
      adapter.setHandler(upgrading(codes));
      return (await adapter.fetch(handshake())).status;
    },
  },
  {
    runtime: 'bun',
    cause: 'an upgrade on the fetch path, which has no server',
    status: 501,
    run: async (codes) => {
      const host: BunServeHost = { serve: () => ({ stop: () => Promise.resolve() }) };
      const adapter = new BunHttpAdapter(host);
      adapter.setHandler(upgrading(codes));
      return (await adapter.fetch(handshake())).status;
    },
  },
];

describe('a handshake the platform cannot complete', () => {
  for (const row of ROWS) {
    it(`${row.runtime}: ${row.cause} answers ${String(row.status)} and closes the sink with 1006`, async () => {
      const codes: number[] = [];

      expect(await row.run(codes)).toBe(row.status);
      expect(codes).toEqual([1006]);
    });
  }
});

/** A request with only the given handshake headers. */
function malformed(extra: Record<string, string>): Request {
  return new Request('http://localhost/ws', {
    headers: { upgrade: 'websocket', connection: 'Upgrade', ...extra },
  });
}

/** One client fault an adapter refuses before asking its platform to upgrade. */
interface ClientRow {
  readonly runtime: 'deno' | 'workers';
  readonly cause: string;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly version: string | null;
}

/**
 * The client-fault arm where the adapter, not the platform, must refuse: Deno
 * (whose upgrade checks only that a key exists) and Workers (whose platform
 * checks after the Worker accepted the pair). Node's `ws` and Bun refuse these
 * themselves; the real-server table is websocket-plugin's `handshake-refusals`.
 */
const CLIENT_ROWS: readonly ClientRow[] = [
  {
    runtime: 'deno',
    cause: 'a malformed key',
    headers: { 'sec-websocket-key': 'short', 'sec-websocket-version': '13' },
    status: 400,
    version: null,
  },
  {
    runtime: 'deno',
    cause: 'version 7',
    headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '7' },
    status: 400,
    version: '13, 8',
  },
  {
    runtime: 'workers',
    cause: 'a malformed key',
    headers: { 'sec-websocket-key': 'short', 'sec-websocket-version': '13' },
    status: 400,
    version: null,
  },
  {
    runtime: 'workers',
    cause: 'version 8',
    headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '8' },
    status: 426,
    version: '13',
  },
];

describe('a client fault the adapter refuses itself', () => {
  for (const row of CLIENT_ROWS) {
    it(`${row.runtime}: ${row.cause} answers ${String(row.status)} without asking the platform to upgrade`, async () => {
      const codes: number[] = [];
      let asked = 0;
      let response: Response;
      if (row.runtime === 'deno') {
        const host: DenoServeHost = {
          serve: () => ({ shutdown: () => Promise.resolve() }),
          upgradeWebSocket: () => {
            asked++;
            throw new Error('not reached');
          },
        };
        const adapter = new DenoHttpAdapter(host);
        adapter.setHandler(upgrading(codes));
        response = await adapter.fetch(malformed(row.headers));
      } else {
        const host: CloudflareWebSocketHost = {
          createPair: () => {
            asked++;
            throw new Error('not reached');
          },
          createUpgradeResponse: () => new Response(null),
        };
        const adapter = new CloudflareWorkersHttpAdapter(host);
        adapter.setHandler(upgrading(codes));
        response = await adapter.fetch(malformed(row.headers));
      }

      expect(response.status).toBe(row.status);
      expect(response.headers.get('sec-websocket-version')).toBe(row.version);
      expect(asked).toBe(0);
      expect(codes).toEqual([1006]);
    });
  }
});

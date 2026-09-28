/**
 * M98l realtime observations against a REAL Redis: two replicas, each a real
 * kernel application with the `'redis'` backplane, a WebSocket plugin and the
 * local diagnostics connector, all opted into realtime observation. A real
 * WebSocket client joins a room on replica B; replica A broadcasts to that
 * room, so the frame crosses real Redis pub/sub and B delivers it.
 *
 * Asserted through each replica's signed connector, the way a devtool reads
 * it: A counts one resolved `backplane-publish` with a measured duration.
 * Redis delivers A's own message back to A's subscriber, and the own-origin
 * filter must drop it before it is counted, so A's only receive is the marker
 * B publishes afterwards. B counts exactly one receive and the one WebSocket
 * send it caused.
 * Canaries planted in the room name, payload and both origins must be absent
 * from every signed response.
 *
 * Guarded on `REDIS_URL` through `ignore`, so a missing Redis reports the
 * test as ignored rather than as a vacuous pass.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IWebSocketService, RealtimeDiagnosticsResponse } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { createDiagnosticsClient, DiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';
import { RealtimeBackplanePlugin } from '../../src/index.ts';

const REDIS_URL = Deno.env.get('REDIS_URL')?.replace(/localhost/g, '127.0.0.1');

const ROOM_CANARY = 'redis-room-canary-SYNTHETIC-0001';
const PAYLOAD_CANARY = 'redis-payload-canary-SYNTHETIC-0002';
const ORIGIN_A = 'redis-origin-a-canary-SYNTHETIC-0003';
const ORIGIN_B = 'redis-origin-b-canary-SYNTHETIC-0004';
const SESSION_ID = 'b'.repeat(32);
const SESSION_KEY = new Uint8Array(32).map((_, index) => index + 7);

function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (pred()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function replica(url: string, topic: string, origin: string, alias: string) {
  const connectorPort = freePort();
  const httpPort = freePort();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      }),
      RealtimeBackplanePlugin({
        transport: 'redis',
        url,
        topic,
        origin,
        diagnostics: { enabled: true, alias: `${alias}-fanout` },
      }),
      WebSocketPlugin({ diagnostics: { enabled: true, alias: `${alias}-chat` } }),
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
  ws.route('/ws', { onOpen: (conn) => ws.room(ROOM_CANARY).add(conn) });
  const frames: string[] = [];
  const client = createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${connectorPort}`,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    subtle: crypto.subtle,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      frames.push(await response.clone().text());
      return response;
    },
    timing: { setTimeout, clearTimeout },
  });
  return { app, ws, httpPort, client, frames };
}

function source(response: RealtimeDiagnosticsResponse, alias: string) {
  const entry = response.sources.find((candidate) => candidate.snapshot.alias === alias);
  if (entry === undefined) {
    throw new Error(`no source ${alias}`);
  }
  return entry.snapshot;
}

function record(snapshot: ReturnType<typeof source>, operation: string) {
  return snapshot.records.find((candidate) => candidate.operation === operation);
}

describe('M98l realtime observations over a REAL Redis backplane', () => {
  it('counts the publish on A and the receive on B, and drops A’s own echo', {
    ignore: REDIS_URL === undefined,
  }, async () => {
    const topic = `m98l-${crypto.randomUUID()}`;
    const a = await replica(REDIS_URL!, topic, ORIGIN_A, 'a');
    const b = await replica(REDIS_URL!, topic, ORIGIN_B, 'b');
    let socket: WebSocket | undefined;
    try {
      const received: string[] = [];
      socket = new WebSocket(`ws://127.0.0.1:${b.httpPort}/ws`);
      socket.onmessage = (event) => received.push(String(event.data));
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve();
        socket!.onerror = () => reject(new Error('socket failed to open'));
      });
      await waitFor(() => b.ws.connectionCount === 1, 'the member to join on B');

      // A broadcasts to a room it has no local member of: the frame reaches
      // B only through Redis.
      a.ws.room(ROOM_CANARY).broadcast(PAYLOAD_CANARY);
      await waitFor(() => received.length === 1, 'the frame to cross Redis');
      expect(received).toEqual([PAYLOAD_CANARY]);

      // Give A's own echo time to arrive back through Redis, so the absence
      // of an A receive below is a real filter result, not a race.
      const echoMarker = crypto.randomUUID();
      b.ws.room(`marker-${echoMarker}`).broadcast('m');
      await new Promise((resolve) => setTimeout(resolve, 250));

      const fromA = await a.client.realtime();
      const fromB = await b.client.realtime();

      const aFanout = source(fromA, 'a-fanout');
      expect(aFanout.sourceKind).toBe('backplane');
      expect(record(aFanout, 'backplane-publish')).toMatchObject({
        count: 1,
        succeeded: 1,
        failed: 0,
        backpressureCloses: null,
      });
      expect(typeof record(aFanout, 'backplane-publish')?.lastDurationMs).toBe('number');
      // A's subscriber also received B's marker publish, which is a genuine
      // receive; A's own broadcast came back too and was dropped by origin.
      expect(record(aFanout, 'backplane-receive')).toMatchObject({ count: 1, succeeded: 1 });

      const bFanout = source(fromB, 'b-fanout');
      expect(record(bFanout, 'backplane-receive')).toMatchObject({ count: 1, succeeded: 1 });
      expect(record(bFanout, 'backplane-publish')).toMatchObject({ count: 1, succeeded: 1 });

      const bChat = source(fromB, 'b-chat');
      // Two rooms on B: the member's room and the marker room B broadcast to.
      expect(bChat.gauges).toEqual({ state: 'available', openConnections: 1, groups: 2 });
      expect(record(bChat, 'send')).toMatchObject({ count: 1, succeeded: 1 });
      const aChat = source(fromA, 'a-chat');
      expect(aChat.gauges).toEqual({ state: 'available', openConnections: 0, groups: 1 });
      expect(record(aChat, 'send')).toBeUndefined();

      const wire = [...a.frames, ...b.frames].join('\n');
      for (const canary of [ROOM_CANARY, PAYLOAD_CANARY, ORIGIN_A, ORIGIN_B, topic]) {
        expect({ canary, leaked: wire.includes(canary) }).toEqual({ canary, leaked: false });
      }
      // Positive control: the approved aliases did reach the wire.
      expect(wire).toContain('"a-fanout"');
      expect(wire).toContain('"b-chat"');
    } finally {
      if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise((resolve) => (socket!.onclose = resolve));
        socket.close();
        await closed;
      }
      a.client.close();
      b.client.close();
      await a.app.stop();
      await b.app.stop();
    }
  });
});

/**
 * End-to-end canary for realtime lifecycle observations (M98l): a REAL kernel
 * application bound to a REAL socket, a REAL browser-grade `WebSocket` client,
 * a REAL SSE stream, a REAL memory backplane fanning out to a peer, the
 * connector's multi-source read over the runtime-owned listener, and the
 * signed native client.
 *
 * Canaries are planted in the WebSocket frames, the upgrade query string, a
 * room name, the close reason, the SSE message, channel name and
 * `Last-Event-ID`, and the backplane origin and room. The test asserts every
 * canary is absent at each layer an observation crosses — the source
 * snapshots, the RAW signed wire bytes captured below the client, and the
 * client DTO — while the approved aliases, the per-kind counters and the
 * live gauges remain present, so suppressing every record cannot make it
 * pass. It then repeats the M98b refusals for the realtime target over a raw
 * socket.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  IRealtimeBackplane,
  IRealtimeDiagnosticsSource,
  ISseService,
  IWebSocketService,
  RealtimeDiagnosticsResponse,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { MemoryBackplane, RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { requestMacFields, signFields } from '../../src/security/authentication.ts';
import { importTestKey, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const FRAME_CANARY = 'ws-frame-canary-SYNTHETIC-0001';
const QUERY_CANARY = 'ws-query-canary-SYNTHETIC-0002';
const ROOM_CANARY = 'ws-room-canary-SYNTHETIC-0003';
const REASON_CANARY = 'ws-reason-canary-SYNTHETIC-0004';
const SSE_CANARY = 'sse-data-canary-SYNTHETIC-0005';
const CHANNEL_CANARY = 'sse-channel-canary-SYNTHETIC-0006';
const LAST_ID_CANARY = 'sse-last-id-canary-SYNTHETIC-0007';
const ORIGIN_CANARY = 'backplane-origin-canary-SYNTHETIC-0008';
const PEER_ROOM_CANARY = 'backplane-room-canary-SYNTHETIC-0009';

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

function waitFor<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 5000);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function startRealtimeApplication(bus: string) {
  const connectorPort = freePort();
  const httpPort = freePort();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      RealtimeBackplanePlugin({
        transport: 'memory',
        bus,
        origin: ORIGIN_CANARY,
        localNotice: false,
        diagnostics: { enabled: true, alias: 'dev-fanout' },
      }),
      WebSocketPlugin({ diagnostics: { enabled: true, alias: 'dev-chat' } }),
      SsePlugin({ diagnostics: { enabled: true, alias: 'dev-feed' } }),
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  return { app, connectorPort, httpPort };
}

function client(connectorPort: number, frames: string[]) {
  return createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${connectorPort}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle: crypto.subtle,
    fetch: capturingFetch(frames),
    timing: { setTimeout, clearTimeout },
  });
}

function byAlias(response: RealtimeDiagnosticsResponse, alias: string) {
  const entry = response.sources.find((source) => source.snapshot.alias === alias);
  if (entry === undefined) {
    throw new Error(`no source ${alias}`);
  }
  return entry.snapshot;
}

function operation(snapshot: ReturnType<typeof byAlias>, name: string) {
  return snapshot.records.find((record) => record.operation === name);
}

describe('Realtime observations e2e (M98l canary)', () => {
  it('minimizes realtime observations end to end: canaries absent, aggregates and gauges present', async () => {
    const bus = `m98l-e2e-${crypto.randomUUID()}`;
    const { app, connectorPort, httpPort } = await startRealtimeApplication(bus);
    const peer = new MemoryBackplane('peer-origin', bus);
    await peer.connect();
    try {
      const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
      const sse = app.services.get<ISseService>(CAPABILITIES.SSE);
      const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
      ws.route('/ws', {
        onOpen: (conn) => ws.room(ROOM_CANARY).add(conn),
        onMessage: (conn, data) => conn.send(`echo:${String(data)}`),
      });
      app.router.get('/events', (ctx) => {
        const conn = sse.open(ctx);
        sse.channel(CHANNEL_CANARY).add(conn);
        conn.send({ id: 'x', data: SSE_CANARY });
        return conn.result;
      });

      // A real WebSocket: open, one echo round trip, a room broadcast, and a
      // close with a canary reason.
      const socket = new WebSocket(`ws://127.0.0.1:${httpPort}/ws?token=${QUERY_CANARY}`);
      await waitFor<void>((done) => {
        socket.onopen = () => done();
      });
      const echoed = waitFor<string>((done) => {
        socket.onmessage = (event) => done(String(event.data));
      });
      socket.send(FRAME_CANARY);
      expect(await echoed).toBe(`echo:${FRAME_CANARY}`);
      ws.room(ROOM_CANARY).broadcast('broadcast');

      // A real SSE stream, read until its first message arrives.
      const controller = new AbortController();
      const stream = await fetch(`http://127.0.0.1:${httpPort}/events`, {
        headers: { 'last-event-id': LAST_ID_CANARY },
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain(SSE_CANARY);

      // A backplane round trip: this app publishes, the peer publishes back.
      await backplane.publish({ kind: 'ws-room', origin: ORIGIN_CANARY, name: 'x', data: 'y' });
      await peer.publish({
        kind: 'ws-room',
        origin: 'peer-origin',
        name: PEER_ROOM_CANARY,
        data: 'aGk=',
      });

      const frames: string[] = [];
      const diagnostics = client(connectorPort, frames);
      const live = await diagnostics.realtime();

      // Close both, then read again: the gauges must fall to zero.
      const socketClosed = waitFor<void>((done) => {
        socket.onclose = () => done();
      });
      socket.close(4000, REASON_CANARY);
      await socketClosed;
      await reader.cancel();
      controller.abort();
      for (
        let attempt = 0;
        attempt < 50 && ws.connectionCount + sse.connectionCount > 0;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const after = await diagnostics.realtime();
      const sources = app.services.getAll<IRealtimeDiagnosticsSource>(
        CAPABILITIES.REALTIME_DIAGNOSTICS,
      );
      const sourceSnapshots = sources.map((source) => source.snapshot());
      diagnostics.close();

      // Useful, positive observations survive minimization.
      expect(live.state).toBe('ready');
      expect(live.sources.map((source) => source.sourceId)).toEqual(['s1', 's2', 's3']);
      const chat = byAlias(live, 'dev-chat');
      expect(chat.sourceKind).toBe('websocket');
      expect(chat.gauges).toEqual({ state: 'available', openConnections: 1, groups: 1 });
      expect(operation(chat, 'open')).toMatchObject({ count: 1, succeeded: 1 });
      expect(operation(chat, 'send')).toMatchObject({ count: 2, succeeded: 2 });
      const feed = byAlias(live, 'dev-feed');
      expect(feed.sourceKind).toBe('sse');
      expect(feed.gauges).toEqual({ state: 'available', openConnections: 1, groups: 1 });
      expect(operation(feed, 'send')).toMatchObject({ count: 1, backpressureCloses: null });
      const fanout = byAlias(live, 'dev-fanout');
      expect(fanout.sourceKind).toBe('backplane');
      expect(fanout.gauges).toEqual({ state: 'unsupported', openConnections: null, groups: null });
      // Two publications: the room broadcast above fans out through the
      // backplane, and so does the direct publish.
      expect(operation(fanout, 'backplane-publish')).toMatchObject({ count: 2, succeeded: 2 });
      expect(operation(fanout, 'backplane-receive')).toMatchObject({ count: 1 });

      const chatAfter = byAlias(after, 'dev-chat');
      expect(chatAfter.gauges).toEqual({ state: 'available', openConnections: 0, groups: 0 });
      expect(operation(chatAfter, 'close')).toMatchObject({ count: 1 });
      const feedAfter = byAlias(after, 'dev-feed');
      expect(feedAfter.gauges.openConnections).toBe(0);
      expect(operation(feedAfter, 'close')).toMatchObject({
        count: 1,
        succeeded: 1,
        backpressureCloses: 0,
      });

      // Every canary is absent at every layer: source, raw signed wire, DTO.
      const layers = {
        source: JSON.stringify(sourceSnapshots),
        wire: frames.join('\n'),
        client: JSON.stringify([live, after]),
      };
      const canaries = [
        FRAME_CANARY,
        QUERY_CANARY,
        ROOM_CANARY,
        REASON_CANARY,
        SSE_CANARY,
        CHANNEL_CANARY,
        LAST_ID_CANARY,
        ORIGIN_CANARY,
        PEER_ROOM_CANARY,
        'peer-origin',
      ];
      for (const [layer, text] of Object.entries(layers)) {
        for (const canary of canaries) {
          expect({ layer, leaked: text.includes(canary) }).toEqual({ layer, leaked: false });
        }
      }
      // Positive control: the approved aliases are on the wire, so suppressing
      // every record could not have passed the canary loop.
      for (const alias of ['"dev-chat"', '"dev-feed"', '"dev-fanout"']) {
        expect(frames.some((frame) => frame.includes(alias))).toBe(true);
      }
    } finally {
      await peer.close();
      await app.stop();
    }
  });

  it('answers disabled sources, never reading a gauge, when no plugin opted in', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        WebSocketPlugin(),
        SsePlugin({ scalingNotice: false }),
      ],
      diagnostics: {},
    });
    await app.start();
    try {
      const diagnostics = client(connectorPort, []);
      const response = await diagnostics.realtime();
      diagnostics.close();
      expect(response.state).toBe('disabled');
      expect(response.sources.map((source) => source.snapshot.sourceKind)).toEqual([
        'websocket',
        'sse',
      ]);
      for (const source of response.sources) {
        expect(source.snapshot.gauges).toEqual({
          state: 'disabled',
          openConnections: null,
          groups: null,
        });
      }
    } finally {
      await app.stop();
    }
  });

  it('answers unsupported when no realtime plugin is registered', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
      ],
      diagnostics: {},
    });
    await app.start();
    try {
      const diagnostics = client(connectorPort, []);
      const response = await diagnostics.realtime();
      diagnostics.close();
      expect(response).toMatchObject({ state: 'unsupported', sources: [] });
    } finally {
      await app.stop();
    }
  });
});

/** Sends one RAW request over a fresh TCP connection. */
async function rawRequest(port: number, raw: string): Promise<{ status: number; body: string }> {
  const connection = await Deno.connect({ port, hostname: '127.0.0.1' });
  await connection.write(new TextEncoder().encode(raw));
  const response = await connection.readable.getReader().read();
  await connection.close();
  const text = new TextDecoder().decode(response.value);
  const [head, ...rest] = text.split('\r\n\r\n');
  return { status: Number.parseInt(head.split('\r\n')[0].split(' ')[1], 10), body: rest.join('') };
}

describe('Realtime observations e2e — M98b refusals for /v1/realtime', () => {
  it('refuses unauthenticated, browser, rebinding, mutating, cross-instance and replayed reads', async () => {
    const { app, connectorPort: port } = await startRealtimeApplication(
      `m98l-refusals-${crypto.randomUUID()}`,
    );
    try {
      const key = await importTestKey(crypto.subtle);
      const target = '/v1/realtime';
      const sign = (
        sequence: number,
        instance: string,
        path = target,
        host = `127.0.0.1:${port}`,
      ) =>
        signFields(
          crypto.subtle,
          key,
          requestMacFields(TEST_SESSION_ID, instance, String(sequence), host, path),
        );
      const request = (
        sequence: number,
        instance: string,
        mac: string,
        extra = '',
        method = 'GET',
        path = target,
        host = `127.0.0.1:${port}`,
      ) =>
        `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
        `X-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Sequence: ${sequence}\r\n` +
        `X-Setu-Instance: ${instance}\r\nX-Setu-Mac: ${mac}\r\n${extra}\r\n`;

      const statusMac = await signFields(
        crypto.subtle,
        key,
        requestMacFields(TEST_SESSION_ID, '', '1', `127.0.0.1:${port}`, '/v1/status'),
      );
      const paired = await rawRequest(
        port,
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `X-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Sequence: 1\r\nX-Setu-Mac: ${statusMac}\r\n\r\n`,
      );
      expect(paired.status).toBe(200);
      const body = JSON.parse(paired.body) as {
        instanceId: string;
        inspectors: Record<string, boolean>;
      };
      expect(body.inspectors.realtime).toBe(true);
      const instance = body.instanceId;
      const otherInstance = '0'.repeat(8) + instance.slice(8);

      expect(
        (await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`))
          .status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(2, instance, await sign(2, instance), 'Origin: null\r\n')))
          .status,
      ).toBe(400);
      // DNS rebinding: a valid MAC over the rebound authority, and no Origin.
      const rebound = `rebind.example:${port}`;
      expect(
        (await rawRequest(
          port,
          request(
            3,
            instance,
            await sign(3, instance, target, rebound),
            '',
            'GET',
            target,
            rebound,
          ),
        )).status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(4, instance, await sign(4, instance), '', 'POST'))).status,
      ).toBe(400);
      expect((await rawRequest(port, request(5, instance, 'f'.repeat(64)))).status).toBe(401);
      expect(
        (await rawRequest(port, request(6, otherInstance, await sign(6, otherInstance)))).status,
      ).toBe(401);
      const query = '/v1/realtime?after=0';
      expect(
        (await rawRequest(
          port,
          request(7, instance, await sign(7, instance, query), '', 'GET', query),
        )).status,
      ).toBe(400);
      const honest = request(8, instance, await sign(8, instance));
      const served = await rawRequest(port, honest);
      expect(served.status).toBe(200);
      expect((JSON.parse(served.body) as { state: string }).state).toBe('ready');
      expect((await rawRequest(port, honest)).status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});

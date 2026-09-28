/**
 * End-to-end canary for event dispatch observations (M98j): a REAL Deno
 * socket, the REAL kernel application, the REAL runtime-owned listener, a
 * REAL EventsPlugin publishing real events through the observed bus, the
 * connector's multi-source read, and the signed native client.
 *
 * Canaries are planted in the event payload, the event id, the aggregate id,
 * a handler's thrown error, and an UNAPPROVED event type. The test asserts
 * every canary is absent at each layer an observation crosses — the source
 * snapshot, the RAW signed wire bytes captured below the client, and the
 * client DTO — while the useful aggregates (publish/handler counters under
 * the approved alias) remain present, so suppressing every record cannot
 * make it pass. It then repeats the M98b refusals for the event target over
 * a raw socket.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IEventBus, IEventDiagnosticsSource, IPlugin } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { EventsPlugin } from '@setu-ts/events-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { requestMacFields, signFields } from '../../src/security/authentication.ts';
import { PLUGIN_ERRORS } from '../../src/plugin/diagnostics-plugin.ts';
import { MAX_EVENT_SOURCES } from '../../src/protocol/event-protocol.ts';
import { importTestKey, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const PAYLOAD_CANARY = 'event-payload-canary-SYNTHETIC-0001';
const EVENT_ID_CANARY = 'event-id-canary-SYNTHETIC-0002';
const AGGREGATE_CANARY = 'aggregate-canary-SYNTHETIC-0003';
const ERROR_CANARY = 'event-error-canary-SYNTHETIC-0004';
const UNAPPROVED_TYPE = 'secret.unapproved.type';

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

async function startEventApplication() {
  const connectorPort = freePort();
  const handled: string[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      EventsPlugin({
        handlers: [
          {
            type: 'user.created',
            handler: {
              handle(event) {
                handled.push(String((event.data as { name?: string }).name ?? ''));
              },
            },
          },
          {
            type: 'user.created',
            handler: {
              handle() {
                throw new Error(ERROR_CANARY);
              },
            },
          },
          {
            type: UNAPPROVED_TYPE,
            handler: {
              handle() {
                handled.push('unapproved');
              },
            },
          },
        ],
        diagnostics: {
          enabled: true,
          alias: 'dev-bus',
          events: { 'user.created': 'users' },
        },
      }),
    ],
    diagnostics: {},
  });
  await app.start();
  return { app, connectorPort, handled };
}

describe('Event observations e2e (M98j canary)', () => {
  it('minimizes event observations end to end: canaries absent, aggregates present', async () => {
    const { app, connectorPort, handled } = await startEventApplication();
    try {
      const bus = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish({
        type: 'user.created',
        id: EVENT_ID_CANARY,
        occurredOn: new Date(0),
        data: { name: PAYLOAD_CANARY },
        aggregateId: AGGREGATE_CANARY,
      });
      // The unapproved type IS dispatched (application behavior unchanged)
      // but is never observed.
      await bus.publish({
        type: UNAPPROVED_TYPE,
        id: 'unapproved-id',
        occurredOn: new Date(0),
        data: PAYLOAD_CANARY,
      });
      expect(handled).toEqual([PAYLOAD_CANARY, 'unapproved']);

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.events();
      const sources = app.services.getAll<IEventDiagnosticsSource>(
        CAPABILITIES.EVENTS_DIAGNOSTICS,
      );
      const sourceSnapshots = sources.map((source) => source.snapshot());
      client.close();

      // Useful, positive observations survive minimization.
      expect(response.version).toEqual(1);
      expect(response.state).toEqual('ready');
      expect(response.sources.length).toEqual(1);
      expect(response.sources[0]!.sourceId).toEqual('s1');
      const snapshot = response.sources[0]!.snapshot;
      expect(snapshot.state).toEqual('ready');
      expect(snapshot.alias).toEqual('dev-bus');
      expect(snapshot.coverage).toEqual('owned-instance');
      const byOperation = Object.fromEntries(
        snapshot.records.map((record) => [record.operation, record]),
      );
      expect(byOperation['publish']!.count).toEqual(1);
      expect(byOperation['publish']!.noSubscribers).toEqual(0);
      expect(byOperation['handler']!.count).toEqual(2);
      expect(byOperation['handler']!.failed).toEqual(1);
      expect(byOperation['handler']!.succeeded).toEqual(1);

      // Every canary is absent at every layer: source, raw signed wire, DTO.
      const layers = {
        source: JSON.stringify(sourceSnapshots),
        wire: frames.join('\n'),
        client: JSON.stringify(response),
      };
      const canaries = [
        PAYLOAD_CANARY,
        EVENT_ID_CANARY,
        AGGREGATE_CANARY,
        ERROR_CANARY,
        UNAPPROVED_TYPE,
        'user.created',
      ];
      for (const [layer, text] of Object.entries(layers)) {
        for (const canary of canaries) {
          expect({ layer, leaked: text.includes(canary) }).toEqual({ layer, leaked: false });
        }
      }
      // The positive control: the approved alias is present on the wire, so
      // suppressing ALL records could not have passed the canary loop.
      expect(frames.some((frame) => frame.includes('"dev-bus"'))).toBe(true);
      expect(frames.some((frame) => frame.includes('"users"'))).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('answers an unsupported event response when no events plugin is present', async () => {
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
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.events();
      client.close();
      expect(response.state).toBe('unsupported');
      expect(response.sources).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('answers a disabled source when EventsPlugin has no diagnostics option', async () => {
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
        EventsPlugin({}),
      ],
      diagnostics: {},
    });
    await app.start();
    try {
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.events();
      client.close();
      expect(response.state).toBe('disabled');
      expect(response.sources.length).toBe(1);
      expect(response.sources[0]!.snapshot.state).toBe('disabled');
      expect(response.sources[0]!.snapshot.alias).toBeNull();
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

describe('Event observations e2e — M98b refusals for /v1/event', () => {
  it('refuses unauthenticated, browser, mutating, cross-instance and replayed event reads', async () => {
    const { app, connectorPort: port } = await startEventApplication();
    try {
      // One approved publication, so the honest read at the end answers a
      // READY snapshot rather than the empty no-data one.
      const bus = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish({
        type: 'user.created',
        id: 'warmup-1',
        occurredOn: new Date(0),
        data: { name: 'warmup' },
      });
      const key = await importTestKey(crypto.subtle);
      const target = '/v1/event';
      const sign = (sequence: number, instance: string, path = target) =>
        signFields(
          crypto.subtle,
          key,
          requestMacFields(TEST_SESSION_ID, instance, String(sequence), `127.0.0.1:${port}`, path),
        );
      const request = (
        sequence: number,
        instance: string,
        mac: string,
        extra = '',
        method = 'GET',
        path = target,
      ) =>
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `X-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Sequence: ${sequence}\r\n` +
        `X-Setu-Instance: ${instance}\r\nX-Setu-Mac: ${mac}\r\n${extra}\r\n`;

      // Pair first, over the raw socket, to learn the bound instance.
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
      const instance = (JSON.parse(paired.body) as { instanceId: string }).instanceId;
      const otherInstance = '0'.repeat(8) + instance.slice(8);

      // Missing credentials, a browser Origin, and a write method.
      expect(
        (await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`))
          .status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(2, instance, await sign(2, instance), 'Origin: null\r\n')))
          .status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(3, instance, await sign(3, instance), '', 'POST'))).status,
      ).toBe(400);
      // A wrong MAC, and a MAC honestly signed for another instance.
      expect((await rawRequest(port, request(4, instance, 'f'.repeat(64)))).status).toBe(401);
      expect(
        (await rawRequest(port, request(5, otherInstance, await sign(5, otherInstance)))).status,
      ).toBe(401);
      // A non-canonical query alias of the snapshot operation.
      const query = '/v1/event?after=0';
      expect(
        (await rawRequest(
          port,
          request(6, instance, await sign(6, instance, query), '', 'GET', query),
        ))
          .status,
      ).toBe(400);
      // An honest read is served; replaying its exact bytes is refused.
      const honest = request(7, instance, await sign(7, instance));
      const served = await rawRequest(port, honest);
      expect(served.status).toBe(200);
      expect((JSON.parse(served.body) as { state: string }).state).toBe('ready');
      expect((await rawRequest(port, honest)).status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});

describe('DiagnosticsPlugin — event source bound (M98j)', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-event-sources',
      version: '0.0.0',
      register(ctx) {
        for (let index = 0; index < count; index++) {
          ctx.services.register<IEventDiagnosticsSource>(
            CAPABILITIES.EVENTS_DIAGNOSTICS,
            {
              snapshot: () => ({
                state: 'disabled',
                alias: null,
                coverage: 'owned-instance',
                records: [],
                dropped: 0,
              }),
            },
            { multi: true },
          );
        }
      },
    };
  }

  function boot(count: number) {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: freePort(),
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        sources(count),
      ],
      diagnostics: {},
    });
    return { app, started: app.start() };
  }

  it('starts with exactly 16 sources', async () => {
    const { app, started } = boot(MAX_EVENT_SOURCES);
    await started;
    await app.stop();
  });

  it('refuses a 17th source with a fixed, value-free configuration error', async () => {
    const { app, started } = boot(MAX_EVENT_SOURCES + 1);
    await expect(started).rejects.toThrow(PLUGIN_ERRORS.tooManyEventSources);
    await app.stop().catch(() => {});
  });
});

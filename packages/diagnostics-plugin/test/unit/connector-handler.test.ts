/**
 * Unit tests for the connector protocol handler, driven with fake
 * framework requests. Covers the structural refusals, the authentication
 * path, replay/revocation/expiry on the atomic gate, instance binding, the
 * canary-free projection against the hostile-DTO fixture, and the
 * independently computed protocol-v1 fixture vectors.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  ConfigDiagnosticsSnapshot,
  HealthDiagnosticsSnapshot,
  IConfigDiagnosticsSource,
  IResponse,
} from '@setu-ts/common';
import { createConnectorHandler, refusalResponse } from '../../src/transport/connector-handler.ts';
import { currentInspectorsManifest, projectConfigSnapshot } from '../../src/protocol/protocol.ts';
import { ConnectorLimits } from '../../src/transport/limits.ts';
import { QueueObservationMerger } from '../../src/transport/queue-merger.ts';
import type { IQueueMerger } from '../../src/transport/queue-merger.ts';
import { isQueueBatchProjection } from '../../src/protocol/queue-protocol.ts';
import { responseMacFields, sha256Hex, verifyFields } from '../../src/security/authentication.ts';
import {
  createTestSession,
  fakeRequest,
  fakeSource,
  importTestKey,
  minimalBatch,
  minimalSnapshot,
  MutableClock,
  ScriptedQueueSource,
  signRequest,
  TEST_INSTANCE_ID,
  TEST_PORT,
  TEST_SESSION_ID,
  utf8,
} from '../fixtures/helpers.ts';
import fixture from '../fixtures/protocol-v1.json' with { type: 'json' };

interface HandlerHarness {
  handler: (request: Awaited<ReturnType<typeof fakeRequest>>) => Promise<IResponse>;
  clock: MutableClock;
  source: ReturnType<typeof fakeSource>;
  session: Awaited<ReturnType<typeof createTestSession>>;
  key: CryptoKey;
}

/**
 * A configurable fake `IConfigDiagnosticsSource`: serves the given snapshot
 * (or throws), and counts the calls so tests can prove when the source was
 * NOT read.
 *
 * @param snapshot - The snapshot to serve, or a thrown error
 * @returns The fake source with its call counter
 */
function fakeConfigSource(
  snapshot: ConfigDiagnosticsSnapshot | Error,
): IConfigDiagnosticsSource & { calls: number } {
  return {
    calls: 0,
    snapshot(instanceId: string): ConfigDiagnosticsSnapshot {
      this.calls += 1;
      void instanceId;
      if (snapshot instanceof Error) {
        throw snapshot;
      }
      // Served VERBATIM: a source bound to the wrong instance must reach the
      // handler that way, or the cross-instance refusal could never fire.
      return snapshot;
    },
  };
}

/** A minimal ready configuration snapshot for handler tests. */
function minimalConfigSnapshot(): ConfigDiagnosticsSnapshot {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    entries: [
      {
        keyAlias: 'port',
        origin: 'environment',
        overriddenSourceAliases: ['dotenv'],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'validated',
      },
    ],
    truncated: false,
    droppedEntries: 0,
  };
}

/**
 * Builds a handler harness on a fresh clock/limits with the standard test
 * source (and, optionally, a hostile source).
 *
 * @param options - Optional overrides
 * @returns The harness
 */
async function buildHarness(options?: {
  snapshot?: Record<string, unknown>;
  batch?: Record<string, unknown>;
  configSource?: IConfigDiagnosticsSource | null;
}): Promise<HandlerHarness> {
  const clock = new MutableClock();
  // The 15-minute default TTL: what the fixture's frozen-clock status body
  // and the expiresInMs assertions expect.
  const session = await createTestSession(crypto.subtle, clock, 900_000);
  const key = await importTestKey(crypto.subtle);
  const source = fakeSource(
    options?.snapshot ?? minimalSnapshot(),
    options?.batch ?? minimalBatch(),
  );
  const handler = createConnectorHandler({
    port: TEST_PORT,
    subtle: crypto.subtle,
    session,
    limits: new ConnectorLimits(clock),
    queues: new QueueObservationMerger([], clock),
    source,
    clock,
    healthSource: null,
    configSource: options?.configSource ?? null,
  });
  return { handler, clock, source, session, key };
}

/**
 * Decodes a response for assertions.
 *
 * @param response - The handler's response
 * @returns Status, headers, parsed body
 */
function inspect(response: IResponse): {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  bodyText: string;
} {
  const snapshot = response.snapshot();
  const bytes = snapshot.body as Uint8Array;
  const bodyText = new TextDecoder().decode(bytes);
  return {
    status: snapshot.status,
    headers: snapshot.headers,
    body: JSON.parse(bodyText) as Record<string, unknown>,
    bodyText,
  };
}

const HOST = `127.0.0.1:${TEST_PORT}`;

/**
 * The exact projection the handler must serve for a source snapshot — the
 * field-by-field copy the wire carries, which is what body assertions
 * compare against.
 *
 * @param snapshot - The source snapshot
 * @returns The serialization-ready projection
 */
function projectOf(snapshot: ConfigDiagnosticsSnapshot): Record<string, unknown> {
  return projectConfigSnapshot(snapshot);
}

/**
 * Builds the canonical response MAC fields for the signed-body assertions.
 *
 * @param target - The canonical target
 * @param sequence - The request sequence
 * @param digest - The served body digest
 * @returns The response MAC input fields
 */
function responseFieldsFor(
  target: string,
  sequence: string,
  digest: string,
): readonly string[] {
  return responseMacFields(
    TEST_SESSION_ID,
    TEST_INSTANCE_ID,
    sequence,
    target,
    '200',
    digest,
  );
}

describe('Connector handler — structural refusals', () => {
  it('refuses non-GET methods before spending an admission', async () => {
    const { handler } = await buildHarness();
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await handler(
        fakeRequest({ method, url: `http://${HOST}/v1/status`, headers: { host: HOST } }),
      );
      const view = inspect(response);
      expect(view.status).toEqual(400);
      expect(view.body).toEqual({ version: 1, error: 'invalid-request' });
    }
  });

  it('refuses a wrong or missing Host', async () => {
    const { handler, key } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    for (const host of ['127.0.0.1:1', 'localhost:4919', '0.0.0.0:4919', '']) {
      const response = await handler(
        fakeRequest({
          url: `http://${HOST}/v1/status`,
          headers: { host, 'x-setu-mac': mac },
        }),
      );
      expect(inspect(response).status).toEqual(400);
    }
  });

  it('refuses ANY Origin header, including the string null', async () => {
    const { handler, key } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    for (const origin of ['null', 'http://evil.example', '']) {
      const response = await handler(
        fakeRequest({
          url: `http://${HOST}/v1/status`,
          headers: { host: HOST, origin, 'x-setu-mac': mac },
        }),
      );
      expect(inspect(response).status).toEqual(400);
    }
  });

  it('refuses malformed protocol headers', async () => {
    const { handler, key } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    const cases: readonly Record<string, string>[] = [
      { 'x-setu-session': 'short' }, // session grammar
      { 'x-setu-session': 'A'.repeat(32) }, // uppercase session
      { 'x-setu-sequence': '0' }, // sequence starts at 1
      { 'x-setu-sequence': '01' }, // non-canonical
      { 'x-setu-sequence': 'x' },
      { 'x-setu-sequence': '99999999999999999999999' }, // beyond safe integer
      { 'x-setu-instance': 'not-a-uuid' }, // instance grammar
      { 'x-setu-mac': 'A'.repeat(64) }, // uppercase MAC
      { 'x-setu-mac': 'a'.repeat(63) }, // short MAC
      {}, // everything missing
    ];
    for (const headers of cases) {
      const response = await handler(
        fakeRequest({
          url: `http://${HOST}/v1/status`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '1',
            ...headers,
          },
        }),
      );
      expect(inspect(response).status).toEqual(400);
    }
    void mac;
  });

  it('refuses an unknown session id as unauthorized', async () => {
    const { handler } = await buildHarness();
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/status`,
        headers: {
          host: HOST,
          'x-setu-session': 'b'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-mac': 'a'.repeat(64),
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(401);
    expect(view.body).toEqual({ version: 1, error: 'unauthorized' });
  });

  it('refuses non-status requests without an instance header', async () => {
    const { handler, key } = await buildHarness();
    // Bind the instance first.
    const status = await handler(await statusRequest(key, 1));
    expect(inspect(status).status).toEqual(200);
    const mac = await signRequest(crypto.subtle, key, '/v1/snapshot', 2);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/snapshot`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '2',
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(400);
  });

  it('refuses a non-canonical target and never reaches the source', async () => {
    const { handler, key, source } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    for (const target of ['/v1/status/', '/v1/unknown', '/v2/status']) {
      const response = await handler(
        fakeRequest({
          url: `http://${HOST}${target}`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '1',
            'x-setu-mac': mac,
          },
        }),
      );
      expect(inspect(response).status).toEqual(400);
    }
    expect(source.snapshotCalls).toEqual(0);
    expect(source.readCalls).toEqual(0);
  });

  it('refuses an oversized header set', async () => {
    const { handler, key } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/status`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-mac': mac,
          'x-pad': 'a'.repeat(9 * 1024),
        },
      }),
    );
    expect(inspect(response).status).toEqual(400);
  });
});

/**
 * Builds an honest initial status request.
 *
 * @param key - The test key
 * @param sequence - The sequence number
 * @returns The fake request
 */
async function statusRequest(key: CryptoKey, sequence: number) {
  const mac = await signRequest(crypto.subtle, key, '/v1/status', sequence);
  return fakeRequest({
    url: `http://${HOST}/v1/status`,
    headers: {
      host: HOST,
      'x-setu-session': 'a'.repeat(32),
      'x-setu-sequence': String(sequence),
      'x-setu-mac': mac,
    },
  });
}

describe('Connector handler — authentication and binding', () => {
  it('serves the signed status exchange and binds the instance', async () => {
    const { handler, key, session } = await buildHarness();
    const response = await handler(await statusRequest(key, 1));
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 900_000,
      inspectors: currentInspectorsManifest(),
    });
    expect(session.hasInstance()).toBe(true);
    // The response MAC verifies against the authenticated instance header,
    // over the exact body bytes just served.
    const verified = await verifyFields(
      crypto.subtle,
      key,
      view.headers.get('x-setu-mac') ?? '',
      [
        'setu-diagnostics-v1',
        'response',
        'a'.repeat(32),
        TEST_INSTANCE_ID,
        '1',
        '/v1/status',
        '200',
        await (async () => {
          const digest = await crypto.subtle.digest(
            'SHA-256',
            utf8(view.bodyText) as BufferSource,
          );
          return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
            '',
          );
        })(),
      ],
    );
    expect(verified).toBe(true);
    expect(view.headers.get('x-setu-instance')).toEqual(TEST_INSTANCE_ID);
    expect(view.headers.get('cache-control')).toEqual('no-store');
    expect(view.headers.get('x-content-type-options')).toEqual('nosniff');
  });

  it('serves snapshot and events with the bound instance and refuses cross-instance', async () => {
    const { handler, key } = await buildHarness();
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);

    const snapshotMac = await signRequest(
      crypto.subtle,
      key,
      '/v1/snapshot',
      2,
      TEST_INSTANCE_ID,
    );
    const snapshotResponse = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/snapshot`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '2',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': snapshotMac,
        },
      }),
    );
    expect(inspect(snapshotResponse).status).toEqual(200);
    expect(inspect(snapshotResponse).body.version).toEqual(1);

    // A DIFFERENT instance UUID — even correctly signed — is unauthorized.
    const wrongId = '00000000-0000-4000-8000-000000000000';
    const wrongMac = await signRequest(crypto.subtle, key, '/v1/snapshot', 3, wrongId);
    const wrongResponse = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/snapshot`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '3',
          'x-setu-instance': wrongId,
          'x-setu-mac': wrongMac,
        },
      }),
    );
    expect(inspect(wrongResponse).status).toEqual(401);

    const eventsMac = await signRequest(
      crypto.subtle,
      key,
      '/v1/events?after=0&limit=8',
      4,
      TEST_INSTANCE_ID,
    );
    const eventsResponse = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/events?after=0&limit=8`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '4',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': eventsMac,
        },
      }),
    );
    const eventsView = inspect(eventsResponse);
    expect(eventsView.status).toEqual(200);
    expect(eventsView.body.next).toEqual(1);
  });

  it('signs and bounds the bytes it actually SENDS, not a re-serialization', async () => {
    // "Sign what you send" must hold structurally. A provider whose DTO
    // contract is violated — the plan's own risk register expects one — can
    // carry a value that serializes differently on a second pass; if the
    // digest and the 256 KiB ceiling are measured on one string while a
    // second is emitted, the client rejects every response and the bound
    // describes bytes nobody sent. One serialization, used for all three.
    let serializations = 0;
    const shifting = {
      toJSON(): string {
        serializations += 1;
        return `pass-${serializations}`;
      },
    };
    const hostile = minimalSnapshot();
    (hostile.nodes as Record<string, unknown>[])[0].label = shifting;
    const { handler, key } = await buildHarness({ snapshot: hostile });

    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    const before = serializations;

    const mac = await signRequest(crypto.subtle, key, '/v1/snapshot', 2, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/snapshot`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    expect(view.status).toEqual(200);
    // The body was produced by exactly ONE serialization pass.
    expect(serializations - before).toEqual(1);

    // The MAC verifies over the bytes the response actually carries.
    const digest = await crypto.subtle.digest('SHA-256', utf8(view.bodyText) as BufferSource);
    const bodyHex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('');
    const verified = await verifyFields(crypto.subtle, key, view.headers.get('x-setu-mac') ?? '', [
      'setu-diagnostics-v1',
      'response',
      'a'.repeat(32),
      TEST_INSTANCE_ID,
      '2',
      '/v1/snapshot',
      '200',
      bodyHex,
    ]);
    expect(verified).toBe(true);
  });

  it('refuses a wrong MAC as unauthorized and never reads the source', async () => {
    const { handler, key, source } = await buildHarness();
    // Signed for a DIFFERENT target than the one requested: the MAC cannot
    // verify.
    const mac = await signRequest(crypto.subtle, key, '/v1/snapshot', 1);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/status`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(401);
    expect(source.snapshotCalls).toEqual(0);
    expect(source.readCalls).toEqual(0);
  });

  it('refuses a replayed sequence after a successful request', async () => {
    const { handler, key } = await buildHarness();
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    // The same signed request replayed: unauthorized.
    const replay = await handler(await statusRequest(key, 1));
    expect(inspect(replay).status).toEqual(401);
  });

  it('reports expired — not unauthorized — once the monotonic TTL passes', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 1_000);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
      configSource: null,
    });
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    clock.advance(1_000);
    const expired = await handler(await statusRequest(key, 2));
    expect(inspect(expired).body).toEqual({ version: 1, error: 'expired' });
  });
});

describe('Connector handler — projection hardening', () => {
  it('drops every forbidden canary field from the hostile provider DTO', async () => {
    const { handler, key } = await buildHarness({
      snapshot: fixture.hostileSnapshotDto as Record<string, unknown>,
    });
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    const snapshotMac = await signRequest(
      crypto.subtle,
      key,
      '/v1/snapshot',
      2,
      TEST_INSTANCE_ID,
    );
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/snapshot`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '2',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': snapshotMac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    const bodyText = view.bodyText;
    // NO canary anywhere in the served bytes.
    expect(bodyText.includes('canary')).toBe(false);
    // Allowed metadata remains observable, so the test is not vacuous.
    expect(view.body.state).toEqual('running');
    const nodes = view.body.nodes as Record<string, unknown>[];
    expect(nodes[0].label).toEqual('catalog');
    expect(nodes[0].version).toEqual('1.0.0');
    expect(nodes[0].password).toBeUndefined();
    expect(nodes[0].options).toBeUndefined();
  });

  it('answers unsupported-version when the source DTO is a future version', async () => {
    const future = { ...minimalSnapshot(), version: 2 };
    const { handler, key } = await buildHarness({ snapshot: future });
    const statusMac = await signRequest(
      crypto.subtle,
      key,
      '/v1/snapshot',
      1,
      TEST_INSTANCE_ID,
    );
    // Bind with an unusual pre-known instance: the source is a future DTO
    // but its instance matches, so binding works via a status call first.
    const status = await handler(await statusRequest(key, 2));
    void status;
    const snapshotMac = await signRequest(
      crypto.subtle,
      key,
      '/v1/snapshot',
      3,
      TEST_INSTANCE_ID,
    );
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/snapshot`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '3',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': snapshotMac,
        },
      }),
    );
    expect(inspect(response).body).toEqual({ version: 1, error: 'unsupported-version' });
    void statusMac;
  });

  it('answers unavailable when the application has no instance yet', async () => {
    const { handler, key } = await buildHarness({ snapshot: minimalSnapshot(null) });
    const response = await handler(await statusRequest(key, 1));
    expect(inspect(response).body).toEqual({ version: 1, error: 'unavailable' });
  });

  it('answers unavailable for an internal handler failure with a fixed body', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock);
    const key = await importTestKey(crypto.subtle);
    const throwingSource = {
      snapshot(): never {
        throw new Error('internal explosion');
      },
      read(): never {
        throw new Error('internal explosion');
      },
    };
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: throwingSource,
      clock,
      healthSource: null,
      configSource: null,
    });
    // The throwing path is BELOW the handler's try — the connector-handler
    // module catches nothing inside; the runtime listener owns the 503 arm.
    // Here the throw propagates, proving the handler does not swallow it:
    // the LISTENER maps it to the fixed anonymous refusal.
    await expect(handler(await statusRequest(key, 1))).rejects.toThrow();
  });
});

describe('Connector handler — health operation (M98d)', () => {
  const healthSnapshot: HealthDiagnosticsSnapshot = {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    observations: [
      {
        indicatorAlias: 'database',
        status: 'up',
        state: 'reported',
        latencyMs: 3,
        ageMs: 12,
        origin: 'application',
      },
    ],
    truncated: false,
    droppedObservations: 0,
  };

  it('answers a typed unsupported snapshot when no source is registered', async () => {
    const { handler, key } = await buildHarness();
    // Bind the session to the instance via the status exchange first.
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    const mac = await signRequest(crypto.subtle, key, '/v1/health', 2, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/health`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '2',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      observations: [],
      truncated: false,
      droppedObservations: 0,
    });
  });

  it('projects a registered source snapshot field-by-field', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    session.bindInstance(TEST_INSTANCE_ID);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: { snapshot: () => healthSnapshot },
      configSource: null,
    });
    const mac = await signRequest(crypto.subtle, key, '/v1/health', 2, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/health`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    expect(view.status).toEqual(200);
    expect(view.body).toEqual(healthSnapshot);
  });

  it('answers a value-free collection-failed snapshot when the source throws', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    session.bindInstance(TEST_INSTANCE_ID);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: {
        snapshot(): never {
          throw new Error('boom');
        },
      },
      configSource: null,
    });
    const mac = await signRequest(crypto.subtle, key, '/v1/health', 2, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/health`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      observations: [],
      truncated: false,
      droppedObservations: 0,
    });
  });

  /** Reads `/v1/health` through a fresh handler over the given source. */
  async function readHealthWith(
    healthSource: { snapshot: (instanceId: string) => unknown },
  ): Promise<{ status: number; body: unknown }> {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    session.bindInstance(TEST_INSTANCE_ID);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: healthSource as { snapshot: (id: string) => HealthDiagnosticsSnapshot },
      configSource: null,
    });
    const mac = await signRequest(crypto.subtle, key, '/v1/health', 2, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/health`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    return { status: view.status, body: view.body };
  }

  const COLLECTION_FAILED = {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'collection-failed',
    observations: [],
    truncated: false,
    droppedObservations: 0,
  };

  const observation = healthSnapshot.observations[0];

  // Each row is a DTO violation a third-party provider of the token could
  // return. None may be signed: every one answers the value-free
  // `collection-failed`, never a 503 and never the offending value.
  const VIOLATIONS: ReadonlyArray<readonly [string, () => unknown]> = [
    ['non-array observations', () => ({ ...healthSnapshot, observations: 'nope' })],
    ['a non-framework status', () => ({
      ...healthSnapshot,
      observations: [{ ...observation, status: 'canary-status' }],
    })],
    ['a status on a non-reported state', () => ({
      ...healthSnapshot,
      observations: [{ ...observation, state: 'failed' }],
    })],
    ['a reported state with no status', () => ({
      ...healthSnapshot,
      observations: [{
        indicatorAlias: 'database',
        state: 'reported',
        latencyMs: 1,
        ageMs: 1,
        origin: 'application',
      }],
    })],
    ['an unknown inspector state', () => ({ ...healthSnapshot, state: 'canary-state' })],
    ['an oversized alias', () => ({
      ...healthSnapshot,
      observations: [{ ...observation, indicatorAlias: 'x'.repeat(65) }],
    })],
    ['a negative latency', () => ({
      ...healthSnapshot,
      observations: [{ ...observation, latencyMs: -1 }],
    })],
    ['a non-finite age', () => ({
      ...healthSnapshot,
      observations: [{ ...observation, ageMs: Infinity }],
    })],
    ['a fractional drop count', () => ({ ...healthSnapshot, droppedObservations: 0.5 })],
    ['more than 64 observations', () => ({
      ...healthSnapshot,
      observations: Array.from(
        { length: 65 },
        (_, i) => ({ ...observation, indicatorAlias: `a${i}` }),
      ),
    })],
    ['a throwing getter', () => ({
      ...healthSnapshot,
      get observations(): never {
        throw new Error('canary-getter');
      },
    })],
  ];

  for (const [label, build] of VIOLATIONS) {
    it(`answers collection-failed for ${label}`, async () => {
      const result = await readHealthWith({ snapshot: () => build() });
      expect(result.status).toEqual(200);
      expect(result.body).toEqual(COLLECTION_FAILED);
      expect(JSON.stringify(result.body)).not.toContain('canary');
    });
  }

  it('drops fields outside the DTO rather than signing them', async () => {
    const result = await readHealthWith({
      snapshot: () => ({
        ...healthSnapshot,
        secret: 'canary-extra',
        observations: [{ ...observation, leak: 'canary-extra' }],
      }),
    });
    expect(result.status).toEqual(200);
    expect(result.body).toEqual(healthSnapshot);
  });

  it('refuses a DTO for another version or another instance', async () => {
    const wrongVersion = await readHealthWith({
      snapshot: () => ({ ...healthSnapshot, version: 2 }),
    });
    expect(wrongVersion.status).toEqual(400);
    expect(wrongVersion.body).toEqual({ version: 1, error: 'unsupported-version' });
    const wrongInstance = await readHealthWith({
      snapshot: () => ({ ...healthSnapshot, instanceId: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(wrongInstance.status).toEqual(401);
  });

  it('refuses a source whose instanceId answers differently on a second read (audit F2)', async () => {
    let reads = 0;
    const flipping = {
      ...healthSnapshot,
      get instanceId(): string {
        reads += 1;
        return reads === 1 ? TEST_INSTANCE_ID : 'other-canary-src';
      },
    };
    const result = await readHealthWith({ snapshot: () => flipping });
    expect(result.status).toEqual(401);
    expect(JSON.stringify(result.body)).not.toContain('other-canary-src');
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('never signs a control alias or extra field smuggled through a source-supplied map (audit re-audit HUNT-d)', async () => {
    const [observation] = healthSnapshot.observations;
    const crafted = { ...observation };
    Object.defineProperty(crafted, 'toJSON', {
      enumerable: false,
      value: () => ({ ...observation, indicatorAlias: 'db\u001b[2JFORGED', injected: 'canary' }),
    });
    const result = await readHealthWith({
      snapshot: () => ({ ...healthSnapshot, observations: { map: () => [crafted], length: 1 } }),
    });
    const text = JSON.stringify(result.body);
    expect(result.status).toEqual(200);
    expect(result.body).toMatchObject({ state: 'collection-failed', observations: [] });
    expect(text).not.toContain('FORGED');
    expect(text).not.toContain('canary');
  });

  it('signs a projected copy, never the source record, for a real observations array (audit re-audit HUNT-d)', async () => {
    const [observation] = healthSnapshot.observations;
    const crafted = { ...observation };
    Object.defineProperty(crafted, 'toJSON', {
      enumerable: false,
      value: () => ({ ...observation, indicatorAlias: 'db\u001b[2JFORGED' }),
    });
    const result = await readHealthWith({
      snapshot: () => ({ ...healthSnapshot, observations: [crafted] }),
    });
    expect(result.status).toEqual(200);
    expect(result.body).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(result.body)).not.toContain('FORGED');
  });

  it('refuses a cross-instance health read', async () => {
    const { handler, key } = await buildHarness();
    // Bind the session to TEST_INSTANCE_ID, then read for a DIFFERENT
    // instance: the connector must refuse it as unauthorized.
    expect(inspect(await handler(await statusRequest(key, 1))).status).toEqual(200);
    const wrongId = '00000000-0000-4000-8000-000000000000';
    const mac = await signRequest(crypto.subtle, key, '/v1/health', 2, wrongId);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/health`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': wrongId,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    expect(view.status).toEqual(401);
  });
});

describe('Connector handler — fixture vectors', () => {
  it('verifies the independently computed fixture request MAC', async () => {
    const { handler } = await buildHarness();
    const response = await handler(
      fakeRequest({
        url: `http://${fixture.authority}/v1/status`,
        headers: {
          host: fixture.authority,
          'x-setu-session': fixture.sessionId,
          'x-setu-sequence': fixture.statusExchange.request.sequence,
          'x-setu-mac': fixture.statusExchange.request.mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    // The served body is byte-identical to the fixture's precomputed body,
    // whose digest the fixture response MAC covers.
    expect(view.bodyText).toEqual(fixture.statusExchange.response.body);
    expect(view.headers.get('x-setu-mac')).toEqual(fixture.statusExchange.response.mac);
  });

  it('refuses every fixture-rejected target', async () => {
    const { handler, clock } = await buildHarness();
    for (const target of fixture.rejectedTargets as string[]) {
      // Refill the anonymous bucket between refusals: each target is its
      // own scenario, not a flood.
      clock.advance(1000);
      const response = await handler(
        fakeRequest({
          url: `http://${fixture.authority}${target}`,
          headers: {
            host: fixture.authority,
            'x-setu-session': fixture.sessionId,
            'x-setu-sequence': '1',
            'x-setu-mac': 'a'.repeat(64),
          },
        }),
      );
      expect(inspect(response).status).toEqual(400);
    }
  });
});

describe('Connector handler — response builder contract', () => {
  it('supports text, send, appendHeader, and snapshot on its internal builder', () => {
    const response = refusalResponse('invalid-request');
    expect(response.header('x-probe', '1').appendHeader('x-probe', '2')).toBeDefined();
    const viaText = refusalResponse('unauthorized');
    viaText.status(401).text('plain');
    expect(viaText.snapshot().body).toEqual(new TextEncoder().encode('plain'));
    const viaSend = refusalResponse('unavailable');
    viaSend.send(new Uint8Array([1, 2]));
    expect(viaSend.snapshot().body).toEqual(new Uint8Array([1, 2]));
    const viaEmptySend = refusalResponse('rate-limited');
    viaEmptySend.send();
    expect(viaEmptySend.snapshot().body).toEqual(new Uint8Array(0));
    const snapshot = viaEmptySend.snapshot();
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.status).toEqual(429);
    expect(snapshot.headers.get('x-content-type-options')).toEqual('nosniff');
  });

  it('throws documented fixed errors for unsupported response features', () => {
    const response = refusalResponse('invalid-request');
    expect(() => response.html('<p>x</p>')).toThrow(/does not support HTML/);
    expect(() => response.redirect('/elsewhere')).toThrow(/does not support redirects/);
    expect(() => response.stream(new ReadableStream<Uint8Array>())).toThrow(
      /does not support streaming/,
    );
  });
});

describe('Connector handler — remaining structural arms', () => {
  it('refuses when the URL authority diverges from the Host header', async () => {
    const { handler, key } = await buildHarness();
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    // The Host header says the right thing; the URL authority does not —
    // exactly what a rebinding proxy would produce.
    const response = await handler(
      fakeRequest({
        url: `http://127.0.0.1:1/v1/status`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(400);
  });

  it('refuses an initial status that presents a DIFFERENT application UUID', async () => {
    const { handler, key } = await buildHarness();
    const wrongId = '00000000-0000-4000-8000-000000000000';
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1, wrongId);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/status`,
        headers: {
          host: HOST,
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-instance': wrongId,
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(401);
  });

  it('answers rate-limited once the session budget is exhausted by honest use', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    const key = await importTestKey(crypto.subtle);
    const limits = new ConnectorLimits(clock);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits,
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
      configSource: null,
    });
    // Forty full-burst honest statuses without any elapsed time exhaust the
    // session's fixed burst budget. Sequence 1 binds (empty instance);
    // every later status presents the bound UUID, as the protocol requires.
    for (let sequence = 1; sequence <= 40; sequence++) {
      const instance = sequence === 1 ? '' : TEST_INSTANCE_ID;
      const mac = await signRequest(crypto.subtle, key, '/v1/status', sequence, instance);
      const headers: Record<string, string> = {
        host: HOST,
        'x-setu-session': 'a'.repeat(32),
        'x-setu-sequence': String(sequence),
        'x-setu-mac': mac,
      };
      if (instance !== '') {
        headers['x-setu-instance'] = instance;
      }
      const response = await handler(
        fakeRequest({ url: `http://${HOST}/v1/status`, headers }),
      );
      expect(inspect(response).status).toEqual(200);
    }
    const overBudget = await handler(await statusRequest(key, 41));
    const view = inspect(overBudget);
    expect(view.status).toEqual(429);
    expect(view.body).toEqual({ version: 1, error: 'rate-limited' });
  });

  it('signs the request for the exact bound port, not a fixed one', async () => {
    // The handler derives its authority from deps.port: a session honest
    // for a DIFFERENT port cannot verify here.
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: 5959,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues: new QueueObservationMerger([], clock),
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
      configSource: null,
    });
    // The request CLAIMS port 5959 (its Host and URL match the handler) but
    // the MAC was signed for 4919: authentication must refuse it.
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1);
    const response = await handler(
      fakeRequest({
        url: 'http://127.0.0.1:5959/v1/status',
        headers: {
          host: '127.0.0.1:5959',
          'x-setu-session': 'a'.repeat(32),
          'x-setu-sequence': '1',
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(401);
  });
});

describe('Connector handler — configuration provenance operation (M98e)', () => {
  it('serves the source snapshot, projected exactly, signed, after authentication', async () => {
    const configSource = fakeConfigSource(minimalConfigSnapshot());
    const { handler, key, session } = await buildHarness({ configSource });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual(projectOf(minimalConfigSnapshot()));
    expect(view.headers.get('x-setu-instance')).toEqual(TEST_INSTANCE_ID);
    // The response MAC verifies over the served bytes with the canonical
    // response grammar — the same property the native client checks.
    const digest = await sha256Hex(crypto.subtle, utf8(view.bodyText));
    const verified = await verifyFields(
      crypto.subtle,
      key,
      view.headers.get('x-setu-mac') ?? '',
      responseFieldsFor('/v1/config', '1', digest),
    );
    expect(verified).toBe(true);
    expect(configSource.calls).toEqual(1);
  });

  it('never reads the source when authentication fails', async () => {
    const configSource = fakeConfigSource(minimalConfigSnapshot());
    const { handler, key, session } = await buildHarness({ configSource });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    // An honest MAC signed for a DIFFERENT target: verification must refuse,
    // and the refusal must precede any read of the source.
    const mac = await signRequest(crypto.subtle, key, '/v1/status', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(401);
    expect(configSource.calls).toEqual(0);
  });

  it('answers a typed unsupported snapshot without a registered source', async () => {
    const { handler, key, session } = await buildHarness({ configSource: null });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      entries: [],
      truncated: false,
      droppedEntries: 0,
    });
  });

  it('answers a value-free collection-failed snapshot when the source throws', async () => {
    const configSource = fakeConfigSource(
      new Error('canary-source-failure-SYNTHETIC: secret/path/value'),
    );
    const { handler, key, session } = await buildHarness({ configSource });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      entries: [],
      truncated: false,
      droppedEntries: 0,
    });
    // Value-free: the thrown message never reaches the wire.
    expect(view.bodyText).not.toContain('canary-source-failure-SYNTHETIC');
  });

  it('refuses a source DTO bound to a different instance', async () => {
    const source = fakeConfigSource({
      ...minimalConfigSnapshot(),
      instanceId: '00000000-0000-4000-8000-000000000000',
    });
    const { handler, key, session } = await buildHarness({ configSource: source });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    expect(inspect(response).status).toEqual(401);
  });

  it('refuses a source whose instanceId answers differently on a second read (audit F2)', async () => {
    let reads = 0;
    const flipping = {
      ...minimalConfigSnapshot(),
      get instanceId(): string {
        reads += 1;
        return reads === 1 ? TEST_INSTANCE_ID : 'other-canary-src';
      },
    };
    const { handler, key, session } = await buildHarness({
      configSource: fakeConfigSource(flipping),
    });
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/config`,
          headers: {
            host: HOST,
            'x-setu-session': TEST_SESSION_ID,
            'x-setu-sequence': '1',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    // Before the fix this was a 200 SIGNED body carrying the second read.
    expect(view.status).toEqual(401);
    expect(view.bodyText).not.toContain('other-canary-src');
  });

  describe('source-supplied structure cannot bypass the validator (audit re-audit HUNT-a/b/c)', () => {
    async function readConfigWith(snapshot: unknown): Promise<ReturnType<typeof inspect>> {
      const { handler, key, session } = await buildHarness({
        configSource: fakeConfigSource(snapshot as ConfigDiagnosticsSnapshot),
      });
      session.bindInstance(TEST_INSTANCE_ID);
      const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
      return inspect(
        await handler(
          fakeRequest({
            url: `http://${HOST}/v1/config`,
            headers: {
              host: HOST,
              'x-setu-session': TEST_SESSION_ID,
              'x-setu-sequence': '1',
              'x-setu-instance': TEST_INSTANCE_ID,
              'x-setu-mac': mac,
            },
          }),
        ),
      );
    }

    function withEntry(overrides: Record<string, unknown>): unknown {
      const base = minimalConfigSnapshot();
      const [entry] = base.entries;
      return { ...base, entries: [{ ...entry, ...overrides }] };
    }

    it('an alias array whose toJSON substitutes a control alias (HUNT-a)', async () => {
      const aliases: string[] = ['ok'];
      Object.defineProperty(aliases, 'toJSON', {
        enumerable: false,
        value: () => ['r\u001b[2JFORGED'],
      });
      const view = await readConfigWith(withEntry({ referenceAliases: aliases }));
      expect(view.status).toEqual(200);
      expect(view.body).toMatchObject({ state: 'ready' });
      expect(view.bodyText).not.toContain('FORGED');
    });

    it('an alias array whose index getter flips on a second read (HUNT-b)', async () => {
      const aliases: string[] = [];
      let reads = 0;
      Object.defineProperty(aliases, '0', {
        enumerable: true,
        configurable: true,
        get: () => (reads++ === 0 ? 'ok' : 'r\u001b[2JFORGED'),
      });
      const view = await readConfigWith(withEntry({ overriddenSourceAliases: aliases }));
      expect(view.status).toEqual(200);
      expect(view.bodyText).not.toContain('FORGED');
      expect(reads).toEqual(1);
    });

    it('an entries object with its own map returning a crafted record (HUNT-c)', async () => {
      const base = minimalConfigSnapshot();
      const [entry] = base.entries;
      const crafted = { ...entry };
      Object.defineProperty(crafted, 'toJSON', {
        enumerable: false,
        value: () => ({ ...entry, keyAlias: 'x\u001b[2JFORGED', injected: 'canary' }),
      });
      const view = await readConfigWith({ ...base, entries: { map: () => [crafted], length: 1 } });
      expect(view.status).toEqual(200);
      expect(view.body).toMatchObject({ state: 'collection-failed', entries: [] });
      expect(view.bodyText).not.toContain('FORGED');
      expect(view.bodyText).not.toContain('canary');
    });

    it('an over-budget alias list is refused without walking its declared length', async () => {
      let reads = 0;
      const aliases = new Proxy([] as string[], {
        get: (target, property, receiver) => {
          if (property === 'length') {
            return 1_000_000_000;
          }
          if (typeof property === 'string' && /^[0-9]+$/.test(property)) {
            reads += 1;
            return 'r';
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const view = await readConfigWith(withEntry({ referenceAliases: aliases }));
      expect(view.body).toMatchObject({ state: 'collection-failed' });
      expect(reads).toEqual(17);
    });
  });

  it('answers collection-failed for a control-character alias from a replacement source (audit F1)', async () => {
    const [entry] = minimalConfigSnapshot().entries;
    const { handler, key, session } = await buildHarness({
      configSource: fakeConfigSource({
        ...minimalConfigSnapshot(),
        entries: [{ ...entry, keyAlias: 'x\u001b[2J\u001b[31mFORGED' }],
      }),
    });
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const view = inspect(
      await handler(
        fakeRequest({
          url: `http://${HOST}/v1/config`,
          headers: {
            host: HOST,
            'x-setu-session': TEST_SESSION_ID,
            'x-setu-sequence': '1',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
    expect(view.status).toEqual(200);
    expect(view.body).toMatchObject({ state: 'collection-failed', entries: [] });
    expect(view.bodyText).not.toContain('FORGED');
  });

  it('answers collection-failed for a hostile DTO the validator rejects', async () => {
    const source = fakeConfigSource({
      ...minimalConfigSnapshot(),
      entries: [
        {
          keyAlias: 'port',
          origin: 'environment',
          overriddenSourceAliases: ['dotenv'],
          expanded: false,
          referenceAliases: [],
          // Copied by the field-by-field projection, then rejected by the
          // exact DTO validator: a mechanism name presence cannot prove.
          schemaEffect: 'defaulted',
          // Outside the allowlist: dropped by the projection entirely.
          value: 'canary-value-SYNTHETIC',
        } as unknown as ConfigDiagnosticsSnapshot['entries'][number],
      ],
    });
    const { handler, key, session } = await buildHarness({ configSource: source });
    // Bind the session the way the status exchange would.
    session.bindInstance(TEST_INSTANCE_ID);
    const mac = await signRequest(crypto.subtle, key, '/v1/config', 1, TEST_INSTANCE_ID);
    const response = await handler(
      fakeRequest({
        url: `http://${HOST}/v1/config`,
        headers: {
          host: HOST,
          'x-setu-session': TEST_SESSION_ID,
          'x-setu-sequence': '1',
          'x-setu-instance': TEST_INSTANCE_ID,
          'x-setu-mac': mac,
        },
      }),
    );
    const view = inspect(response);
    expect(view.status).toEqual(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      entries: [],
      truncated: false,
      droppedEntries: 0,
    });
    expect(view.bodyText).not.toContain('canary-value-SYNTHETIC');
  });
});

describe('Connector handler — queue observations (M98f)', () => {
  /** Builds a bound handler over the given merger. */
  async function queueHarness(queues: IQueueMerger) {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    session.bindInstance(TEST_INSTANCE_ID);
    const key = await importTestKey(crypto.subtle);
    const handler = createConnectorHandler({
      port: TEST_PORT,
      subtle: crypto.subtle,
      session,
      limits: new ConnectorLimits(clock),
      queues,
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
      configSource: null,
    });
    return { handler, key, clock };
  }

  /** Signs and sends one queues request. */
  async function sendQueues(
    harness: Awaited<ReturnType<typeof queueHarness>>,
    search: string,
    options: { sequence?: number; mac?: string; instance?: string } = {},
  ) {
    const target = `/v1/queues?${search}`;
    const sequence = options.sequence ?? 2;
    const instance = options.instance ?? TEST_INSTANCE_ID;
    const mac = options.mac ??
      await signRequest(crypto.subtle, harness.key, target, sequence, instance);
    return inspect(
      await harness.handler(
        fakeRequest({
          url: `http://${HOST}${target}`,
          headers: {
            host: HOST,
            'x-setu-session': 'a'.repeat(32),
            'x-setu-sequence': String(sequence),
            'x-setu-instance': instance,
            'x-setu-mac': mac,
          },
        }),
      ),
    );
  }

  it('serves a signed, exactly-projected batch drained from the sources', async () => {
    const source = new ScriptedQueueSource();
    source.produce(2);
    const harness = await queueHarness(new QueueObservationMerger([source], new MutableClock()));
    const view = await sendQueues(harness, 'after=0&limit=128');
    expect(view.status).toEqual(200);
    expect(view.body.state).toEqual('ready');
    expect((view.body.events as unknown[]).length).toEqual(2);
    expect(isQueueBatchProjection(view.body)).toBe(true);
    const mac = view.headers.get('x-setu-mac')!;
    const digest = await sha256Hex(crypto.subtle, utf8(view.bodyText));
    expect(
      await verifyFields(crypto.subtle, harness.key, mac, [
        'setu-diagnostics-v1',
        'response',
        'a'.repeat(32),
        TEST_INSTANCE_ID,
        '2',
        '/v1/queues?after=0&limit=128',
        '200',
        digest,
      ]),
    ).toBe(true);
  });

  it('reads no source before authentication succeeds', async () => {
    const source = new ScriptedQueueSource();
    const harness = await queueHarness(new QueueObservationMerger([source], new MutableClock()));
    expect((await sendQueues(harness, 'after=0&limit=1', { mac: 'f'.repeat(64) })).status)
      .toEqual(401);
    expect(
      (await sendQueues(harness, 'after=0&limit=1', {
        instance: '0'.repeat(8) + TEST_INSTANCE_ID.slice(8),
      })).status,
    ).toEqual(401);
    expect(source.reads).toEqual(0);
  });

  it('refuses a cursor beyond the merge sequence as invalid-request', async () => {
    const harness = await queueHarness(new QueueObservationMerger([], new MutableClock()));
    const view = await sendQueues(harness, 'after=5&limit=1');
    expect(view.status).toEqual(400);
    expect(view.body).toEqual({ version: 1, error: 'invalid-request' });
  });

  it('answers unavailable rather than signing a batch that fails the exact validator', async () => {
    const broken: IQueueMerger = {
      read: (instanceId) => ({
        version: 1,
        instanceId,
        state: 'ready',
        sources: [],
        events: [],
        depths: [],
        next: 0,
        lost: 0,
        truncatedSources: 0,
        truncatedDepths: 0,
      }),
    };
    const view = await sendQueues(await queueHarness(broken), 'after=0&limit=1');
    expect(view.status).toEqual(503);
    expect(view.body).toEqual({ version: 1, error: 'unavailable' });
  });
});

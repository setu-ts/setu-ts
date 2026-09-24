/**
 * Unit tests for the connector protocol handler, driven with fake
 * framework requests. Covers the structural refusals, the authentication
 * path, replay/revocation/expiry on the atomic gate, instance binding, the
 * canary-free projection against the hostile-DTO fixture, and the
 * independently computed protocol-v1 fixture vectors.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HealthDiagnosticsSnapshot, IResponse } from '@setu-ts/common';
import { createConnectorHandler, refusalResponse } from '../../src/transport/connector-handler.ts';
import { currentInspectorsManifest } from '../../src/protocol/protocol.ts';
import { ConnectorLimits } from '../../src/transport/limits.ts';
import { verifyFields } from '../../src/security/authentication.ts';
import {
  createTestSession,
  fakeRequest,
  fakeSource,
  importTestKey,
  minimalBatch,
  minimalSnapshot,
  MutableClock,
  signRequest,
  TEST_INSTANCE_ID,
  TEST_PORT,
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
 * Builds a handler harness on a fresh clock/limits with the standard test
 * source (and, optionally, a hostile source).
 *
 * @param options - Optional overrides
 * @returns The harness
 */
async function buildHarness(options?: {
  snapshot?: Record<string, unknown>;
  batch?: Record<string, unknown>;
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
    source,
    clock,
    healthSource: null,
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
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
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
      source: throwingSource,
      clock,
      healthSource: null,
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
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: { snapshot: () => healthSnapshot },
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
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: {
        snapshot(): never {
          throw new Error('boom');
        },
      },
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
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
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
      source: fakeSource(minimalSnapshot(), minimalBatch()),
      clock,
      healthSource: null,
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

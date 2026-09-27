/**
 * Unit tests for the native client, driven against an IN-MEMORY signed
 * server implemented over the same production protocol helpers the
 * connector-handler uses. The canonicalization itself is pinned
 * independently in `authentication.test.ts` and by the fixture vectors in
 * `connector-handler.test.ts`; this file covers client behavior: pairing,
 * verification, sequence serialization, tampering, bounds, deadlines, and
 * terminal failures.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { DiagnosticsClientOptions } from '../../src/interfaces/index.ts';
import { CLIENT_ERRORS, createDiagnosticsClient } from '../../src/client/client.ts';
import {
  importSessionKey,
  requestMacFields,
  responseMacFields,
  sha256Hex,
  signFields,
  verifyFields,
} from '../../src/security/authentication.ts';
import {
  currentInspectorsManifest,
  INSPECTOR_KEYS,
  STATUS_BASE_KEYS,
} from '../../src/protocol/protocol.ts';
import {
  minimalBatch,
  minimalSnapshot,
  TEST_INSTANCE_ID,
  TEST_KEY_BYTES,
  TEST_PORT,
  TEST_SESSION_ID,
} from '../fixtures/helpers.ts';

/**
 * Local assertion helper: fails the test when the condition is false.
 *
 * @param value - The condition
 * @param label - What the condition asserts
 */
function assertTrue(value: boolean, label: string): void {
  if (!value) {
    throw new Error('PROBE FAIL: ' + label);
  }
}

/**
 * A recorded request the fake server can assert on.
 *
 * @internal
 */
interface RecordedRequest {
  readonly target: string;
  readonly session: string;
  readonly sequence: string;
  readonly instance: string | null;
  readonly mac: string;
}

/**
 * Builds the fake server: verifies request MACs and answers with correctly
 * signed responses for the configured snapshot/batch, with per-test
 * mutation hooks.
 *
 * @param subtle - The subtle crypto to use
 * @param overrides - Response behavior overrides
 * @returns The fetch implementation and the request log
 */
function fakeServer(
  subtle: SubtleCrypto,
  overrides: {
    mutateBody?: (target: string, bodyText: string) => string;
    dropMac?: boolean;
    wrongInstance?: boolean;
    status?: number;
    oversizedBody?: boolean;
    redirect?: boolean;
    malformedBody?: boolean;
    /** Serve the legacy M98b three-field status body (no manifest). */
    legacyStatus?: boolean;
    /** The manifest to serve in the status body; defaults to the current one. */
    statusInspectors?: Record<string, boolean>;
    /** The body to serve for `/v1/health`; defaults to a ready snapshot. */
    healthBody?: Record<string, unknown>;
    /** The body to serve for `/v1/config`; defaults to a ready snapshot. */
    configBody?: Record<string, unknown>;
    /** The body to serve for `/v1/queues`; defaults to a one-event batch. */
    queuesBody?: (after: number) => Record<string, unknown>;
    /** The body to serve for `/v1/traces`; defaults to a one-record batch. */
    tracesBody?: (after: number) => Record<string, unknown>;
    /** The body to serve for `/v1/snapshot`; defaults to `minimalSnapshot()`. */
    snapshotBody?: () => Record<string, unknown>;
    /** The body to serve for `/v1/events`; defaults to `minimalBatch()`. */
    eventsBody?: (after: number) => Record<string, unknown>;
    /**
     * Per-response identity override, applied BEFORE signing so the hostile
     * response carries a valid MAC. `path` is the target's pathname and
     * `call` counts that pathname's requests from 1. `header` replaces the
     * signed `x-setu-instance`; `body` replaces the body's `instanceId`
     * (`null` serves JSON null, `'omit'` removes the field).
     */
    identity?: (path: string, call: number) => {
      header?: string;
      body?: string | null | 'omit';
    };
  } = {},
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const calls = new Map<string, number>();
  const key = importSessionKey(subtle, TEST_KEY_BYTES);
  const encoder = new TextEncoder();
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    void key;
    return await key.then(async (imported) => {
      const target = `${url.pathname}${url.search}`;
      const session = String(
        requestHeadersOf(input).get('x-setu-session') ?? '',
      );
      const sequence = requestHeadersOf(input).get('x-setu-sequence') ?? '';
      const instance = requestHeadersOf(input).get('x-setu-instance');
      const mac = requestHeadersOf(input).get('x-setu-mac') ?? '';
      requests.push({ target, session, sequence, instance, mac });

      const verified = await verifyFields(
        subtle,
        imported,
        mac,
        requestMacFields(session, instance ?? '', sequence, `127.0.0.1:${TEST_PORT}`, target),
      );
      if (!verified) {
        return new Response(JSON.stringify({ version: 1, error: 'unauthorized' }), {
          status: 401,
        });
      }
      if (overrides.redirect) {
        return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      }
      if (overrides.status !== undefined) {
        return new Response('nope', { status: overrides.status });
      }

      let bodyText: string;
      if (target === '/v1/status') {
        const body: Record<string, unknown> = {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          expiresInMs: 899_000,
        };
        if (!overrides.legacyStatus) {
          body.inspectors = overrides.statusInspectors ?? currentInspectorsManifest();
        }
        bodyText = JSON.stringify(body);
      } else if (target === '/v1/snapshot') {
        bodyText = JSON.stringify(overrides.snapshotBody?.() ?? minimalSnapshot());
      } else if (target === '/v1/health') {
        bodyText = JSON.stringify(
          overrides.healthBody ?? {
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
          },
        );
      } else if (target === '/v1/config') {
        bodyText = JSON.stringify(
          overrides.configBody ?? {
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
          },
        );
      } else if (url.pathname === '/v1/queues') {
        const after = Number(url.searchParams.get('after'));
        bodyText = JSON.stringify((overrides.queuesBody ?? queueBatchBody)(after));
      } else if (url.pathname === '/v1/traces') {
        const after = Number(url.searchParams.get('after'));
        bodyText = JSON.stringify((overrides.tracesBody ?? traceBatchBody)(after));
      } else {
        const after = Number(url.searchParams.get('after'));
        bodyText = JSON.stringify(overrides.eventsBody?.(after) ?? minimalBatch());
      }
      // Signed, therefore authentic — and not JSON. Deliberately NOT applied
      // to `/v1/status`: the pairing path has always guarded its parse, so a
      // malformed status body fails there with the SAME fixed message and
      // would make this fixture pass without ever reaching the data paths it
      // exists to cover. (Observed: the first version of this test did.)
      if (overrides.malformedBody && target !== '/v1/status') {
        bodyText = '{"version":1,"nodes":[';
      }
      const call = (calls.get(url.pathname) ?? 0) + 1;
      calls.set(url.pathname, call);
      const identity = overrides.identity?.(url.pathname, call) ?? {};
      if (identity.body !== undefined) {
        const record = JSON.parse(bodyText) as Record<string, unknown>;
        if (identity.body === 'omit') {
          delete record.instanceId;
        } else {
          record.instanceId = identity.body;
        }
        bodyText = JSON.stringify(record);
      }
      const headerInstance = identity.header ??
        (overrides.wrongInstance ? '0'.repeat(36) : TEST_INSTANCE_ID);
      // An oversized body the server SIGNS, and which is otherwise a valid
      // snapshot projection. Both halves are load-bearing: serving unsigned
      // bytes would be refused by MAC verification, and serving invalid JSON
      // would be refused by `isSnapshotProjection` — either way the test
      // would pass with the read bound removed, which is what it used to do.
      if (overrides.oversizedBody && target !== '/v1/status') {
        bodyText = JSON.stringify({
          ...minimalSnapshot(),
          pad: 'x'.repeat(300 * 1024),
        });
      }
      // The MAC is computed over the UNMUTATED body; a mutation hook then
      // swaps the served bytes, simulating an attacker tampering AFTER the
      // honest server signed them.
      const bodyBytes = encoder.encode(bodyText);
      const digest = await sha256Hex(subtle, bodyBytes);
      const responseFields = responseMacFields(
        session,
        headerInstance,
        sequence,
        target,
        '200',
        digest,
      );
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-setu-instance': headerInstance,
        'x-setu-mac': overrides.dropMac
          ? 'z'.repeat(64)
          : await signFields(subtle, imported, responseFields),
      };
      let served = bodyBytes;
      if (overrides.mutateBody !== undefined) {
        served = encoder.encode(overrides.mutateBody(target, bodyText));
      }
      return new Response(served, { status: 200, headers });
    });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, requests };
}

/**
 * A well-formed queue batch with one event just past `after`.
 *
 * @param after - The requested merge cursor
 * @returns The batch body
 */
function queueBatchBody(after: number): Record<string, unknown> {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    sources: [{
      sourceId: 'q1',
      state: 'ready',
      instanceAlias: 'mailer',
      depthCoverage: 'complete',
      failure: 'none',
      lost: 0,
      droppedAttempts: 0,
      evictedJobAliases: 0,
    }],
    events: [{
      sequence: after + 1,
      sourceId: 'q1',
      instanceAlias: 'mailer',
      queueAlias: 'emails',
      jobAlias: 'j1',
      attempt: 1,
      durationMs: 2,
      outcome: 'completed',
      settlement: 'acknowledged',
      ageMs: 3,
    }],
    depths: [],
    next: after + 1,
    lost: 0,
    truncatedSources: 0,
    truncatedDepths: 0,
  };
}

/**
 * A well-formed trace batch with one record just past `after`.
 *
 * @param after - The requested sequence cursor
 * @returns The batch body
 */
function traceBatchBody(after: number): Record<string, unknown> {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    coverage: 'completed-sampled-spans',
    instrumentation: ['http'],
    sampler: { kind: 'always-on' },
    records: [{
      sequence: after + 1,
      serviceAlias: 'orders',
      operationAlias: 'create-order',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      links: [],
      kind: 'server',
      outcome: 'ok',
      durationMs: 4,
      ageMs: 6,
      parentVisibility: 'root',
    }],
    next: after + 1,
    lost: 0,
    closed: false,
    droppedSpans: 0,
  };
}

/**
 * Reads the headers of a fetch input the way the fake server receives it.
 * The client calls fetch with a string URL and a headers init; this helper
 * reconstructs them from the last-call record.
 *
 * @param input - The fetch input
 * @returns The recorded headers
 */
function requestHeadersOf(_input: string | URL | Request): Headers {
  return lastHeaders;
}

let lastHeaders = new Headers();

/**
 * Wraps a fetch so the headers init is recorded for the fake server.
 *
 * @param base - The fake server's fetch
 * @returns An instrumented fetch
 */
function recording(base: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    lastHeaders = new Headers(init?.headers);
    return base(input, init);
  }) as typeof fetch;
}

/**
 * Builds a client against the fake server.
 *
 * @param overrides - Server and client overrides
 * @returns The client, the request log, and the timing log
 */
function buildClient(overrides: {
  server?: Parameters<typeof fakeServer>[1];
  client?: Partial<DiagnosticsClientOptions>;
} = {}): {
  client: ReturnType<typeof createDiagnosticsClient>;
  requests: RecordedRequest[];
  timeouts: number[];
} {
  const subtle = crypto.subtle;
  const { fetch, requests } = fakeServer(subtle, overrides.server);
  const timeouts: number[] = [];
  const options: DiagnosticsClientOptions = {
    endpoint: `http://127.0.0.1:${TEST_PORT}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle,
    fetch: recording(fetch),
    timing: {
      setTimeout(fn: () => void, ms: number): unknown {
        timeouts.push(ms);
        return setTimeout(fn, ms);
      },
      clearTimeout(handle: unknown): void {
        clearTimeout(handle as number);
      },
    },
    ...(overrides.client ?? {}),
  };
  return { client: createDiagnosticsClient(options), requests, timeouts };
}

describe('Client — endpoint and option validation', () => {
  it('refuses any endpoint other than exact numeric loopback', () => {
    const base = {
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch: globalThis.fetch,
      timing: {
        setTimeout: (_fn: () => void, _ms: number) => 0,
        clearTimeout: (_h: unknown) => {},
      },
    };
    const bad = [
      'https://127.0.0.1:4919',
      'http://localhost:4919',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:80',
      'http://127.0.0.1:4919/',
      'http://127.0.0.1:4919/v1/status',
      'http://127.0.0.1:4919?x=1',
      'http://user:pass@127.0.0.1:4919',
      'http://127.0.0.1:4919#frag',
      'not a url',
    ];
    for (const endpoint of bad) {
      expect(() => createDiagnosticsClient({ ...base, endpoint })).toThrow(
        CLIENT_ERRORS.endpoint,
      );
    }
  });

  it('refuses malformed credentials at creation', () => {
    const base = {
      endpoint: `http://127.0.0.1:${TEST_PORT}`,
      subtle: crypto.subtle,
      fetch: globalThis.fetch,
      timing: {
        setTimeout: (_fn: () => void, _ms: number) => 0,
        clearTimeout: (_h: unknown) => {},
      },
    };
    expect(() =>
      createDiagnosticsClient({ ...base, sessionId: 'short', sessionKey: TEST_KEY_BYTES })
    ).toThrow(CLIENT_ERRORS.sessionId);
    expect(() =>
      createDiagnosticsClient({
        ...base,
        sessionId: TEST_SESSION_ID,
        sessionKey: new Uint8Array(8),
      })
    ).toThrow(CLIENT_ERRORS.sessionKey);
  });
});

describe('Client — pairing and reads', () => {
  it('performs the signed status exchange automatically, then serves reads', async () => {
    const { client, requests } = buildClient();
    const snapshot = await client.snapshot();
    expect(snapshot.version).toEqual(1);
    expect(snapshot.instanceId).toEqual(TEST_INSTANCE_ID);
    expect(snapshot.state).toEqual('running');
    // Two requests: status then snapshot; the status came first and
    // carried NO instance header.
    expect(requests.length).toEqual(2);
    expect(requests[0].target).toEqual('/v1/status');
    expect(requests[0].instance).toBe(null);
    expect(requests[1].target).toEqual('/v1/snapshot');
    expect(requests[1].instance).toEqual(TEST_INSTANCE_ID);
    client.close();
  });

  it('reads events after binding and enforces the argument bounds', async () => {
    const { client, requests } = buildClient();
    // The fake serves sequence 1, which is past cursor 0 — a batch starting
    // at or before the cursor is refused (see the cursor-contract suite).
    const batch = await client.read(0, 16);
    expect(batch.version).toEqual(1);
    expect(batch.next).toEqual(1);
    // Status, then the canonical events target in exact order.
    expect(requests[1].target).toEqual('/v1/events?after=0&limit=16');
    await expect(client.read(-1)).rejects.toThrow(CLIENT_ERRORS.arguments);
    await expect(client.read(0, 0)).rejects.toThrow(CLIENT_ERRORS.arguments);
    await expect(client.read(0, 129)).rejects.toThrow(CLIENT_ERRORS.arguments);
    client.close();
  });

  it('serializes calls and reserves strictly increasing sequence numbers', async () => {
    const { client, requests } = buildClient();
    const [snapshot, batch] = await Promise.all([
      client.snapshot(),
      client.read(0, 4),
    ]);
    expect(snapshot.version).toEqual(1);
    expect(batch.version).toEqual(1);
    const sequences = requests.map((r) => Number.parseInt(r.sequence, 10));
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    client.close();
  });
});

describe('Client — verification and bounds', () => {
  it('treats a mutated response body as a connection failure', async () => {
    const { client } = buildClient({
      server: {
        mutateBody: (target, body) =>
          target === '/v1/snapshot' ? JSON.stringify(minimalSnapshot('0'.repeat(36))) : body,
      },
    });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('treats a broken response MAC as a connection failure', async () => {
    const { client } = buildClient({ server: { dropMac: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('treats a non-200 as a connection failure without parsing', async () => {
    const { client } = buildClient({ server: { status: 503 } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses an oversized body through the read bound', async () => {
    // The body is correctly signed AND a well-formed snapshot projection, so
    // the 256 KiB stream ceiling is the ONLY thing that can refuse it: raise
    // MAX_BODY_BYTES and this resolves instead of rejecting. (Verified.)
    const { client } = buildClient({ server: { oversizedBody: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a redirect instead of following it', async () => {
    const { client } = buildClient({ server: { redirect: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('pairs terminally: a failed status exchange kills the session', async () => {
    const { client } = buildClient({ server: { status: 401 } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    // Terminal: even a now-healthy server cannot revive the identity.
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.pairingFailed);
    await expect(client.read(0)).rejects.toThrow(CLIENT_ERRORS.pairingFailed);
    client.close();
  });

  it('rejects every call after close and clears deadlines', async () => {
    const { client, timeouts } = buildClient();
    await client.snapshot();
    expect(timeouts.every((ms) => ms === 5_000)).toBe(true);
    client.close();
    client.close(); // idempotent
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.closed);
    await expect(client.read(0)).rejects.toThrow(CLIENT_ERRORS.closed);
  });

  it('sends credentials: omit and no redirects, exact headers, no body', async () => {
    const { client, requests } = buildClient();
    await client.snapshot();
    expect(requests[0].session).toEqual(TEST_SESSION_ID);
    expect(requests[0].mac).toMatch(/^[0-9a-f]{64}$/);
    client.close();
  });

  it('answers its own fixed error for an authentic but malformed body', async () => {
    // The body VERIFIES (the server signed exactly these bytes) and is not
    // JSON. A raw `JSON.parse` here throws a `SyntaxError` whose V8 message
    // quotes the offending peer bytes — the client's stated contract is that
    // no failure echoes server input, and the pairing path already guarded
    // this. Both data paths must too.
    const { client } = buildClient({ server: { malformedBody: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();

    const second = buildClient({ server: { malformedBody: true } });
    await expect(second.client.read(0, 8)).rejects.toThrow(CLIENT_ERRORS.connection);
    second.client.close();
  });

  it('carries the status body base keys exactly once', () => {
    // The client's own validator: exact key set, so an envelope smuggled by
    // a hostile server is refused. STATUS_BASE_KEYS is the exported allowlist
    // the validator checks against; the new body adds exactly one more key,
    // `inspectors`.
    expect(STATUS_BASE_KEYS).toEqual(['version', 'instanceId', 'expiresInMs']);
    expect(INSPECTOR_KEYS.length).toEqual(11);
  });
});

describe('Client — health negotiation (M98d)', () => {
  it('serves a health read through the signed exchange when the manifest is true', async () => {
    const { client, requests } = buildClient();
    const health = await client.health();
    expect(health.version).toEqual(1);
    expect(health.instanceId).toEqual(TEST_INSTANCE_ID);
    expect(health.state).toEqual('ready');
    expect(health.observations[0].indicatorAlias).toEqual('database');
    expect(health.observations[0].status).toEqual('up');
    // Status, then the canonical health target.
    expect(requests.length).toEqual(2);
    expect(requests[1].target).toEqual('/v1/health');
    client.close();
  });

  it('answers unsupported WITHOUT an addon request when the manifest key is false', async () => {
    const allFalse = Object.fromEntries(INSPECTOR_KEYS.map((key) => [key, false]));
    const { client, requests } = buildClient({ server: { statusInspectors: allFalse } });
    const health = await client.health();
    expect(health.state).toEqual('unsupported');
    expect(health.observations).toEqual([]);
    // ONLY the status exchange went out — no `/v1/health` request.
    expect(requests.length).toEqual(1);
    expect(requests[0].target).toEqual('/v1/status');
    client.close();
  });

  it('pairs against the legacy M98b three-field body and reports all keys false', async () => {
    const { client, requests } = buildClient({ server: { legacyStatus: true } });
    const health = await client.health();
    // The legacy body resolved to the all-false manifest: unsupported, and no
    // addon request was sent.
    expect(health.state).toEqual('unsupported');
    expect(requests.length).toEqual(1);
    expect(requests[0].target).toEqual('/v1/status');
    client.close();
  });

  it('refuses a health body that fails the exact DTO validator', async () => {
    const { client } = buildClient({
      server: {
        healthBody: {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          state: 'bogus',
          observations: [],
          truncated: false,
          droppedObservations: 0,
        },
      },
    });
    await expect(client.health()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a health body bound to a different instance than the pairing', async () => {
    const { client } = buildClient({
      server: {
        healthBody: {
          version: 1,
          instanceId: '00000000-0000-4000-8000-000000000000',
          state: 'no-data',
          observations: [],
          truncated: false,
          droppedObservations: 0,
        },
      },
    });
    await expect(client.health()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a health body carrying a field outside the DTO', async () => {
    const { client } = buildClient({
      server: {
        healthBody: {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          state: 'no-data',
          observations: [],
          truncated: false,
          droppedObservations: 0,
          extra: 'canary',
        },
      },
    });
    await expect(client.health()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('returns a deeply frozen snapshot, as documented', async () => {
    const { client } = buildClient();
    const health = await client.health();
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.observations)).toBe(true);
    expect(Object.isFrozen(health.observations[0])).toBe(true);
    client.close();
  });
});

describe('Client — configuration negotiation (M98e)', () => {
  it('serves a provenance read through the signed exchange when the manifest is true', async () => {
    const { client, requests } = buildClient();
    const config = await client.configuration();
    expect(config.version).toEqual(1);
    expect(config.instanceId).toEqual(TEST_INSTANCE_ID);
    expect(config.state).toEqual('ready');
    expect(config.entries[0].keyAlias).toEqual('port');
    expect(config.entries[0].origin).toEqual('environment');
    // Status, then the canonical configuration target.
    expect(requests.length).toEqual(2);
    expect(requests[1].target).toEqual('/v1/config');
    client.close();
  });

  it('answers unsupported WITHOUT an addon request when the manifest key is false', async () => {
    const allFalse = Object.fromEntries(INSPECTOR_KEYS.map((key) => [key, false]));
    const { client, requests } = buildClient({ server: { statusInspectors: allFalse } });
    const config = await client.configuration();
    expect(config.state).toEqual('unsupported');
    expect(config.entries).toEqual([]);
    // ONLY the status exchange went out — no `/v1/config` request.
    expect(requests.length).toEqual(1);
    expect(requests[0].target).toEqual('/v1/status');
    client.close();
  });

  it('pairs against the legacy M98b three-field body and never probes the route', async () => {
    const { client, requests } = buildClient({ server: { legacyStatus: true } });
    const config = await client.configuration();
    // The legacy body resolved to the all-false manifest: unsupported, and no
    // addon request was sent.
    expect(config.state).toEqual('unsupported');
    expect(requests.length).toEqual(1);
    expect(requests[0].target).toEqual('/v1/status');
    client.close();
  });

  it('refuses a config body that fails the exact DTO validator', async () => {
    const { client } = buildClient({
      server: {
        configBody: {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          state: 'bogus',
          entries: [],
          truncated: false,
          droppedEntries: 0,
        },
      },
    });
    await expect(client.configuration()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a config body bound to a different instance than the pairing', async () => {
    const { client } = buildClient({
      server: {
        configBody: {
          version: 1,
          instanceId: '00000000-0000-4000-8000-000000000000',
          state: 'no-data',
          entries: [],
          truncated: false,
          droppedEntries: 0,
        },
      },
    });
    await expect(client.configuration()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a config entry carrying a value-shaped canary outside the DTO', async () => {
    const { client } = buildClient({
      server: {
        configBody: {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          state: 'ready',
          entries: [
            {
              keyAlias: 'port',
              origin: 'environment',
              overriddenSourceAliases: [],
              expanded: false,
              referenceAliases: [],
              schemaEffect: 'validated',
              value: 'canary-value-SYNTHETIC',
            },
          ],
          truncated: false,
          droppedEntries: 0,
        },
      },
    });
    await expect(client.configuration()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('returns a deeply frozen snapshot, as documented', async () => {
    const { client } = buildClient();
    const config = await client.configuration();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.entries)).toBe(true);
    expect(Object.isFrozen(config.entries[0])).toBe(true);
    // The alias arrays nested inside each entry are frozen too.
    expect(config.entries[0].overriddenSourceAliases.length).toBeGreaterThan(0);
    expect(Object.isFrozen(config.entries[0].overriddenSourceAliases)).toBe(true);
    expect(Object.isFrozen(config.entries[0].referenceAliases)).toBe(true);
    client.close();
  });
});

/**
 * Bounds a promise so a regression that HANGS (a body read nothing aborts)
 * fails loudly instead of stalling the suite.
 *
 * @param promise - The promise under test
 * @param ms - The bound
 * @returns The original outcome
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('test timed out — the body read was never aborted')), ms)
    ),
  ]);
}

describe('Client — the deadline and close() govern the body read', () => {
  const encoder = new TextEncoder();

  /**
   * A fetch whose 200 response streams one JSON chunk and then pends
   * forever, unless its abort signal fires — the shape of a stalled
   * loopback endpoint after headers.
   *
   * @param captured - Receives the request's AbortSignal
   * @returns The fake fetch
   */
  function stallingFetch(captured: { signal: AbortSignal | null }): typeof fetch {
    return ((_input: string | URL | Request, init?: RequestInit) => {
      captured.signal = (init?.signal as AbortSignal) ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"version":1'));
          captured.signal?.addEventListener('abort', () => {
            try {
              controller.error(new Error('aborted'));
            } catch {
              // already closed
            }
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': 'a'.repeat(64),
          },
        }),
      );
    }) as typeof fetch;
  }

  function stallClient(captured: { signal: AbortSignal | null }, timing: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  }): ReturnType<typeof createDiagnosticsClient> {
    return createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${TEST_PORT}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch: stallingFetch(captured),
      timing,
    });
  }

  it('keeps the 5-second deadline armed across the body read', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    let deadlineFn: (() => void) | undefined;
    const client = stallClient(captured, {
      setTimeout(fn: () => void, _ms: number): unknown {
        deadlineFn = fn;
        return 0;
      },
      clearTimeout(handle: unknown): void {
        // Mirrors production clearing: once cleared, firing is a no-op.
        if (deadlineFn !== undefined && handle === 0) {
          deadlineFn = undefined;
        }
      },
    });
    const pending = client.snapshot();
    // Let the fetch resolve (headers) and the body read pend on chunk two.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertTrue(captured.signal !== null, 'request captured its abort signal');
    // Fire the deadline: the WHOLE exchange must still be governed by it.
    deadlineFn?.();
    await withTimeout(
      (async () => {
        await expect(pending).rejects.toThrow(CLIENT_ERRORS.connection);
      })(),
      2_000,
    );
    client.close();
  });

  it('aborts an in-flight body read when close() is called', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const client = stallClient(captured, {
      setTimeout: (_fn: () => void, _ms: number) => 0,
      clearTimeout: (_handle: unknown) => {},
    });
    const pending = client.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.close();
    await withTimeout(
      (async () => {
        await expect(pending).rejects.toThrow(CLIENT_ERRORS.connection);
      })(),
      2_000,
    );
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.closed);
  });
});

describe('Client — queue observations (M98f)', () => {
  it('reads queues through the signed exchange and returns a deeply frozen batch', async () => {
    const { client, requests } = buildClient();
    const batch = await client.queues(4, 10);
    expect(batch.state).toEqual('ready');
    expect(batch.events[0].sequence).toEqual(5);
    expect(requests.map((r) => r.target)).toEqual([
      '/v1/status',
      '/v1/queues?after=4&limit=10',
    ]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.events[0])).toBe(true);
    expect(Object.isFrozen(batch.sources[0])).toBe(true);
    const defaulted = await client.queues(0);
    expect(defaulted.next).toEqual(1);
    expect(requests[2].target).toEqual('/v1/queues?after=0&limit=128');
    client.close();
  });

  it('answers unsupported WITHOUT an addon request when the manifest key is false', async () => {
    const noQueues = { ...currentInspectorsManifest(), queues: false };
    const { client, requests } = buildClient({ server: { statusInspectors: noQueues } });
    const batch = await client.queues(9);
    expect(batch).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      sources: [],
      events: [],
      depths: [],
      next: 9,
      lost: 0,
      truncatedSources: 0,
      truncatedDepths: 0,
    });
    expect(Object.isFrozen(batch.sources)).toBe(true);
    expect(requests.map((r) => r.target)).toEqual(['/v1/status']);
    client.close();
  });

  it('treats the legacy M98b status body as no queue inspector', async () => {
    const { client, requests } = buildClient({ server: { legacyStatus: true } });
    expect((await client.queues(0)).state).toEqual('unsupported');
    expect(requests.length).toEqual(1);
    client.close();
  });

  it('refuses bad arguments before sending anything', async () => {
    const { client, requests } = buildClient();
    for (const [after, limit] of [[-1, 1], [1.5, 1], [0, 0], [0, 129]] as const) {
      await expect(client.queues(after, limit)).rejects.toThrow(CLIENT_ERRORS.arguments);
    }
    expect(requests.length).toEqual(0);
    client.close();
  });

  const violations: [string, (after: number) => Record<string, unknown>][] = [
    ['fails the exact DTO validator', (after) => ({ ...queueBatchBody(after), extra: 1 })],
    ['is bound to another instance', (after) => ({
      ...queueBatchBody(after),
      instanceId: '0'.repeat(8) + TEST_INSTANCE_ID.slice(8),
    })],
    ['starts at or before the cursor', (after) => {
      const body = queueBatchBody(after);
      const events = body.events as Record<string, unknown>[];
      events[0].sequence = after;
      body.next = after;
      return body;
    }],
    ['reports a lost that disagrees with the page', (after) => ({
      ...queueBatchBody(after),
      lost: 3,
    })],
    ['moves the cursor on an empty page', (after) => ({
      ...queueBatchBody(after),
      events: [],
      next: after + 2,
    })],
    ['reports loss on an empty page', (after) => ({
      ...queueBatchBody(after),
      events: [],
      next: after,
      lost: 1,
    })],
    ['returns more events than the limit', (after) => {
      const body = queueBatchBody(after);
      const first = (body.events as Record<string, unknown>[])[0];
      body.events = [first, { ...first, sequence: after + 2 }];
      body.next = after + 2;
      return body;
    }],
  ];
  for (const [label, body] of violations) {
    it(`refuses a body that ${label}`, async () => {
      const { client } = buildClient({ server: { queuesBody: body } });
      await expect(client.queues(4, 1)).rejects.toThrow(CLIENT_ERRORS.connection);
      client.close();
    });
  }
});

describe('Client — trace observations (M98g)', () => {
  it('pairs, sends the signed traces request, and returns the validated frozen batch', async () => {
    const { client, requests } = buildClient();
    const batch = await client.traces(0);
    expect(requests.some((request) => request.target === '/v1/traces?after=0&limit=128')).toBe(
      true,
    );
    expect(requests.some((request) => request.instance === TEST_INSTANCE_ID)).toBe(true);
    expect(batch.state).toBe('ready');
    expect(batch.records[0]!.operationAlias).toBe('create-order');
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.records)).toBe(true);
    client.close();
  });

  it('echoes the cursor and limit on the wire for a paged read', async () => {
    const { client, requests } = buildClient();
    const batch = await client.traces(41, 7);
    expect(requests.some((request) => request.target === '/v1/traces?after=41&limit=7')).toBe(
      true,
    );
    expect(batch.records[0]!.sequence).toBe(42);
    client.close();
  });

  it('answers a manifest without the trace inspector locally, without probing the route', async () => {
    const inspectors: Record<string, boolean> = {
      health: true,
      configuration: false,
      queues: true,
      traces: false,
      authorization: false,
      cache: false,
      events: false,
      scheduler: false,
      realtime: false,
      storage: false,
      outboundHttp: false,
    };
    const { client, requests } = buildClient({
      server: { statusInspectors: inspectors },
    });
    const batch = await client.traces(9);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('unknown');
    expect(batch.next).toBe(9);
    expect(requests.some((request) => request.target.startsWith('/v1/traces'))).toBe(false);
    client.close();
  });

  it('refuses a served body that fails the exact trace validator', async () => {
    const bad = traceBatchBody(0);
    (bad.records as Record<string, unknown>[])[0]!.spanId = 'not-a-span-id';
    const { client } = buildClient({ server: { tracesBody: () => bad } });
    await expect(client.traces(0)).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a served body whose cursor contract disagrees with the request', async () => {
    const bad = traceBatchBody(5);
    bad.lost = 3; // first sequence is 6: the gap must be 0, not 3
    const { client } = buildClient({ server: { tracesBody: () => bad } });
    await expect(client.traces(5)).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses invalid arguments before any request', async () => {
    const { client, requests } = buildClient();
    await expect(client.traces(-1)).rejects.toThrow(CLIENT_ERRORS.arguments);
    await expect(client.traces(0, 0)).rejects.toThrow(CLIENT_ERRORS.arguments);
    expect(requests.every((request) => !request.target.startsWith('/v1/traces'))).toBe(true);
    client.close();
  });
});

/**
 * A second valid instance UUID, distinct from the pairing identity. Every
 * hostile response below is CORRECTLY SIGNED with the session key — these
 * are not bad MACs — so only the paired-instance binding can refuse them.
 */
const OTHER_INSTANCE_ID = '9b2c1f7e-5a3d-4e8b-8c61-2f0d7a4b9e15';

/**
 * The header/body identity mismatches a key holder can sign. Each must be
 * refused once the session has paired with {@linkcode TEST_INSTANCE_ID}.
 */
const HOSTILE_IDENTITIES: ReadonlyArray<{
  readonly label: string;
  readonly header?: string;
  readonly body?: string | null | 'omit';
}> = [
  { label: 'header B, body A', header: OTHER_INSTANCE_ID },
  { label: 'header A, body B', body: OTHER_INSTANCE_ID },
  { label: 'header B, body B', header: OTHER_INSTANCE_ID, body: OTHER_INSTANCE_ID },
];

/**
 * Every network operation the client sends after pairing, with the target
 * path the fake server sees. Iterated by the header-binding table so an
 * operation added later without a row is a visible omission.
 */
const PAIRED_OPERATIONS: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly call: (client: ReturnType<typeof createDiagnosticsClient>) => Promise<unknown>;
}> = [
  { name: 'snapshot()', path: '/v1/snapshot', call: (c) => c.snapshot() },
  { name: 'read()', path: '/v1/events', call: (c) => c.read(0, 4) },
  { name: 'health()', path: '/v1/health', call: (c) => c.health() },
  { name: 'configuration()', path: '/v1/config', call: (c) => c.configuration() },
  { name: 'queues()', path: '/v1/queues', call: (c) => c.queues(0, 4) },
  { name: 'traces()', path: '/v1/traces', call: (c) => c.traces(0, 4) },
];

describe('Client — paired-instance binding (correctly signed hostile responses)', () => {
  it('pins OTHER_INSTANCE_ID as a distinct, valid identity', () => {
    // Vacuity guard: a hostile identity equal to the paired one would make
    // every refusal below pass for the wrong reason.
    expect(OTHER_INSTANCE_ID).not.toBe(TEST_INSTANCE_ID);
    expect(OTHER_INSTANCE_ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  for (
    const variant of [
      { label: 'header B, body A', header: OTHER_INSTANCE_ID },
      { label: 'header A, body B', body: OTHER_INSTANCE_ID },
    ]
  ) {
    it(`fails initial status pairing terminally for ${variant.label}`, async () => {
      const { client, requests } = buildClient({
        server: { identity: (path) => (path === '/v1/status' ? variant : {}) },
      });
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.pairingFailed);
      // Only the failed status exchange reached the server.
      expect(requests.map((r) => r.target)).toEqual(['/v1/status']);
      client.close();
    });
  }

  it('accepts honest A/A responses for every paired operation', async () => {
    const { client } = buildClient();
    for (const op of PAIRED_OPERATIONS) {
      await op.call(client);
    }
    client.close();
  });

  for (const variant of HOSTILE_IDENTITIES) {
    it(`refuses the first snapshot after pairing for ${variant.label}`, async () => {
      const { client, requests } = buildClient({
        server: { identity: (path) => (path === '/v1/snapshot' ? variant : {}) },
      });
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
      // The status exchange paired honestly; the refusal is the snapshot's.
      expect(requests.map((r) => r.target)).toEqual(['/v1/status', '/v1/snapshot']);
      client.close();
    });

    it(`refuses a subsequent snapshot for ${variant.label}`, async () => {
      const { client } = buildClient({
        server: {
          identity: (path, call) => (path === '/v1/snapshot' && call === 2 ? variant : {}),
        },
      });
      expect((await client.snapshot()).instanceId).toBe(TEST_INSTANCE_ID);
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
      // A post-pairing identity refusal is a connection failure like any
      // other verification failure — not terminal: an honest next exchange
      // still succeeds under the SAME paired identity.
      expect((await client.snapshot()).instanceId).toBe(TEST_INSTANCE_ID);
      client.close();
    });

    it(`refuses the first and a subsequent event read for ${variant.label}`, async () => {
      const first = buildClient({
        server: { identity: (path) => (path === '/v1/events' ? variant : {}) },
      });
      await expect(first.client.read(0, 4)).rejects.toThrow(CLIENT_ERRORS.connection);
      first.client.close();

      const later = buildClient({
        server: {
          identity: (path, call) => (path === '/v1/events' && call === 2 ? variant : {}),
        },
      });
      expect((await later.client.read(0, 4)).instanceId).toBe(TEST_INSTANCE_ID);
      await expect(later.client.read(0, 4)).rejects.toThrow(CLIENT_ERRORS.connection);
      later.client.close();
    });
  }

  for (const body of [null, 'omit'] as const) {
    const label = body === null ? 'a null' : 'a missing';
    it(`refuses ${label} body identity on a paired snapshot and event read`, async () => {
      const { client } = buildClient({
        server: {
          identity: (path) => path === '/v1/snapshot' || path === '/v1/events' ? { body } : {},
        },
      });
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
      await expect(client.read(0, 4)).rejects.toThrow(CLIENT_ERRORS.connection);
      client.close();
    });
  }

  for (const op of PAIRED_OPERATIONS) {
    it(`binds the signed response header for ${op.name}`, async () => {
      // Body identity stays A: only the header differs, so a body check
      // alone cannot refuse it.
      const { client, requests } = buildClient({
        server: { identity: (path) => (path === op.path ? { header: OTHER_INSTANCE_ID } : {}) },
      });
      await expect(op.call(client)).rejects.toThrow(CLIENT_ERRORS.connection);
      expect(requests.some((r) => r.target.startsWith(op.path))).toBe(true);
      client.close();
    });

    it(`binds the body identity for ${op.name}`, async () => {
      const { client } = buildClient({
        server: { identity: (path) => (path === op.path ? { body: OTHER_INSTANCE_ID } : {}) },
      });
      await expect(op.call(client)).rejects.toThrow(CLIENT_ERRORS.connection);
      client.close();
    });
  }

  it('keeps legacy status negotiation: honest core reads pass, a foreign header is refused', async () => {
    const honest = buildClient({ server: { legacyStatus: true } });
    expect((await honest.client.snapshot()).instanceId).toBe(TEST_INSTANCE_ID);
    expect((await honest.client.read(0, 4)).instanceId).toBe(TEST_INSTANCE_ID);
    // Addons stay local `unsupported` answers under a legacy manifest.
    expect((await honest.client.health()).state).toBe('unsupported');
    honest.client.close();

    const hostile = buildClient({
      server: {
        legacyStatus: true,
        identity: (path) => (path === '/v1/snapshot' ? { header: OTHER_INSTANCE_ID } : {}),
      },
    });
    await expect(hostile.client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    hostile.client.close();
  });
});

/**
 * A one-event core batch past `after`, carrying the paired identity.
 *
 * @param after - The requested cursor
 * @param count - How many consecutive events to return
 * @returns The batch body
 */
function coreBatchAfter(after: number, count = 1): Record<string, unknown> {
  const events = Array.from({ length: count }, (_, i) => ({
    sequence: after + 1 + i,
    operationId: `op${after + 1 + i}`,
    parentOperationId: null,
    kind: 'request',
    stage: 'request',
    nodeId: null,
    outcome: 'ok',
    atMs: 1,
    durationMs: 2,
  }));
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    events,
    next: count === 0 ? after : after + count,
    lost: 0,
    closed: false,
  };
}

describe('Client — core DTO validation over correctly signed bodies (F02)', () => {
  // Each body is SIGNED by the fake server, so MAC verification passes and
  // only the DTO validator can refuse it.
  const hostileSnapshots: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
    ['an unknown state', () => ({ ...minimalSnapshot(), state: 'exploded' })],
    ['an extra top-level field', () => ({ ...minimalSnapshot(), secrets: ['x'] })],
    ["a node carrying another kind's field", () => ({
      ...minimalSnapshot(),
      nodes: [{ id: 'p1', kind: 'plugin', method: 'GET' }, {
        id: 'c1',
        kind: 'capability',
      }],
    })],
    ['a dangling edge', () => ({
      ...minimalSnapshot(),
      edges: [{ from: 'p1', to: 'c9', kind: 'owns' }],
    })],
    ['a control character in a label', () => ({
      ...minimalSnapshot(),
      nodes: [{ id: 'p1', kind: 'plugin', label: '\u001b[2Jcatalog' }, {
        id: 'c1',
        kind: 'capability',
      }],
    })],
  ];

  for (const [label, body] of hostileSnapshots) {
    it(`refuses a signed snapshot with ${label}`, async () => {
      const { client, requests } = buildClient({ server: { snapshotBody: body } });
      await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
      expect(requests.map((r) => r.target)).toEqual(['/v1/status', '/v1/snapshot']);
      client.close();
    });
  }

  const hostileBatches: ReadonlyArray<
    readonly [string, (after: number) => Record<string, unknown>]
  > = [
    ['an event field outside the contract', (after) => {
      const batch = coreBatchAfter(after);
      (batch.events as Record<string, unknown>[])[0].message = 'boom';
      return batch;
    }],
    ['an unknown event stage', (after) => {
      const batch = coreBatchAfter(after);
      (batch.events as Record<string, unknown>[])[0].stage = 'sql';
      return batch;
    }],
    ['non-consecutive sequences', (after) => {
      const batch = coreBatchAfter(after, 2);
      (batch.events as Record<string, unknown>[])[1].sequence = after + 5;
      batch.next = after + 5;
      return batch;
    }],
    ['a next that is not the last returned sequence', (after) => ({
      ...coreBatchAfter(after),
      next: after + 7,
    })],
  ];

  for (const [label, body] of hostileBatches) {
    it(`refuses a signed batch with ${label}`, async () => {
      const { client } = buildClient({ server: { eventsBody: body } });
      await expect(client.read(3, 8)).rejects.toThrow(CLIENT_ERRORS.connection);
      client.close();
    });
  }
});

describe('Client — read() cursor contract relative to the request (F02)', () => {
  it('accepts a page past the cursor, an empty page echoing it, and an honest eviction gap', async () => {
    // Vacuity guard for the refusals below: each is one change from these.
    const page = buildClient({ server: { eventsBody: (after) => coreBatchAfter(after, 3) } });
    const batch = await page.client.read(3, 8);
    expect(batch.events.map((e) => e.sequence)).toEqual([4, 5, 6]);
    page.client.close();

    const empty = buildClient({ server: { eventsBody: (after) => coreBatchAfter(after, 0) } });
    expect((await empty.client.read(9, 8)).next).toBe(9);
    empty.client.close();

    const evicted = buildClient({
      server: { eventsBody: (after) => ({ ...coreBatchAfter(after + 4), lost: 4 }) },
    });
    expect((await evicted.client.read(3, 8)).lost).toBe(4);
    evicted.client.close();
  });

  const cases: ReadonlyArray<readonly [string, (after: number) => Record<string, unknown>]> = [
    ['a page starting at the cursor (a replayed event)', (after) => coreBatchAfter(after - 1)],
    ['a page starting before the cursor', () => coreBatchAfter(0)],
    ['more events than the requested limit', (after) => coreBatchAfter(after, 9)],
    ['an empty page that moves the cursor', (after) => ({ ...coreBatchAfter(after, 0), next: 99 })],
    ['an empty page reporting loss', (after) => ({ ...coreBatchAfter(after, 0), lost: 2 })],
    ['a lost count that disagrees with the gap', (after) => ({
      ...coreBatchAfter(after + 4),
      lost: 1,
    })],
  ];

  for (const [label, body] of cases) {
    it(`refuses ${label}`, async () => {
      const { client } = buildClient({ server: { eventsBody: body } });
      await expect(client.read(3, 8)).rejects.toThrow(CLIENT_ERRORS.connection);
      client.close();
    });
  }
});

describe('Client — core results are deeply frozen (F03)', () => {
  it('freezes the snapshot, its nodes, and its edges', async () => {
    const { client } = buildClient();
    const snapshot = await client.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(snapshot.edges)).toBe(true);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.nodes.every((node) => Object.isFrozen(node))).toBe(true);
    expect(snapshot.edges.every((edge) => Object.isFrozen(edge))).toBe(true);
    // A strict-mode write throws rather than silently changing the result.
    expect(() => {
      (snapshot as { state: string }).state = 'closed';
    }).toThrow(TypeError);
    client.close();
  });

  it('freezes the batch and every event', async () => {
    const { client } = buildClient({
      server: { eventsBody: (after) => coreBatchAfter(after, 2) },
    });
    const batch = await client.read(0, 8);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.events)).toBe(true);
    expect(batch.events.length).toBe(2);
    expect(batch.events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(() => {
      (batch.events as unknown[]).push({});
    }).toThrow(TypeError);
    client.close();
  });
});

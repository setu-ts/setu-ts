/**
 * Unit tests for the M98m storage operation: the copy-once source reader and
 * its refusals (getters, prototypes, extra keys, proxies, oversized lists,
 * duplicate aliases, budget overrun), the aggregate state priority, the ONE
 * wire validator, the authenticated `GET /v1/storage` dispatch (source reads
 * only after authentication, unsupported without sources), and the
 * connector's refusal of more than 16 sources at bootstrap.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  IPlugin,
  IResponse,
  IStorageDiagnosticsSource,
  StorageDiagnosticsSnapshot,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  buildStorageResponse,
  isStorageResponseProjection,
  isStorageSnapshotProjection,
  MAX_STORAGE_SOURCES,
} from '../../src/protocol/storage-protocol.ts';
import { parseTarget } from '../../src/protocol/protocol.ts';
import { createConnectorHandler } from '../../src/transport/connector-handler.ts';
import { ConnectorLimits } from '../../src/transport/limits.ts';
import { QueueObservationMerger } from '../../src/transport/queue-merger.ts';
import { DiagnosticsPlugin } from '../../src/index.ts';
import { PLUGIN_ERRORS } from '../../src/plugin/diagnostics-plugin.ts';
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
  TEST_KEY_BYTES,
  TEST_PORT,
  TEST_SESSION_ID,
} from '../fixtures/helpers.ts';

const HOST = `127.0.0.1:${TEST_PORT}`;

/** A well-formed record, with the operation's nullability respected. */
function record(alias = 'primary', operation = 'put'): Record<string, unknown> {
  return {
    alias,
    operation,
    count: 1,
    lastDurationMs: operation === 'getSignedUrl' ? null : 2,
    ageMs: 3,
    succeeded: 1,
    failed: 0,
    lastBytes: operation === 'put' || operation === 'get' ? 4 : null,
  };
}

/** A well-formed ready snapshot. */
function ready(alias = 'primary', records = [record(alias)]): Record<string, unknown> {
  return { state: 'ready', alias, coverage: 'owned-instance', records, dropped: 0 };
}

const DISABLED = {
  state: 'disabled',
  alias: null,
  coverage: 'owned-instance',
  records: [],
  dropped: 0,
};
const FAILED = {
  state: 'collection-failed',
  alias: null,
  coverage: 'owned-instance',
  records: [],
  dropped: 0,
};

/** A source answering `value` (or throwing it when it is an Error). */
function source(value: unknown): IStorageDiagnosticsSource & { calls: number } {
  const s = {
    calls: 0,
    snapshot(): StorageDiagnosticsSnapshot {
      s.calls++;
      if (value instanceof Error) {
        throw value;
      }
      return value as StorageDiagnosticsSnapshot;
    },
  };
  return s;
}

/** The one-source response's first snapshot. */
function only(value: unknown): unknown {
  const response = buildStorageResponse(TEST_INSTANCE_ID, [source(value)]);
  return (response.sources as { snapshot: unknown }[])[0]!.snapshot;
}

describe('storage protocol — target', () => {
  it('parses exactly /v1/storage with no query', () => {
    expect(parseTarget('/v1/storage', '')).toEqual({
      op: 'storage',
      canonicalTarget: '/v1/storage',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/storage', 'after=0&limit=1')).toBeNull();
    expect(parseTarget('/v1/storage/', '')).toBeNull();
  });
});

describe('storage protocol — source reading', () => {
  it('copies a well-formed snapshot (positive control)', () => {
    expect(only(ready())).toEqual(ready());
    expect(only(DISABLED)).toEqual(DISABLED);
    expect(only({ ...ready(), records: [], state: 'no-data' })).toEqual({
      ...ready(),
      records: [],
      state: 'no-data',
    });
    const nullProto = Object.assign(Object.create(null), ready());
    expect(only(nullProto)).toEqual(ready());
  });

  const invalid: ReadonlyArray<[string, () => unknown]> = [
    ['a thrown error', () => new Error('canary-source-SYNTHETIC')],
    ['a non-object', () => 'ready'],
    ['an array', () => []],
    ['a class instance', () => Object.assign(new (class Snapshot {})(), ready())],
    ['an extra key', () => ({ ...ready(), key: 'canary' })],
    ['a missing key', () => {
      const { dropped: _dropped, ...rest } = ready();
      void _dropped;
      return rest;
    }],
    ['a getter', () => {
      const value = { ...ready() };
      Object.defineProperty(value, 'alias', { get: () => 'primary', enumerable: true });
      return value;
    }],
    ['a non-array records', () => ({ ...ready(), records: { length: 1 } })],
    ['a record getter', () => {
      const r = record();
      Object.defineProperty(r, 'count', { get: () => 1, enumerable: true });
      return ready('primary', [r]);
    }],
    ['a sparse record list', () => ready('primary', new Array(1) as never)],
    ['a record with an extra key', () => ready('primary', [{ ...record(), value: 'x' }])],
    ['more than 6 records', () =>
      ready(
        'primary',
        Array.from({ length: 7 }, () => record()),
      )],
    ['an unknown state', () => ({ ...ready(), state: 'unsupported' })],
    ['a wrong coverage', () => ({ ...ready(), coverage: 'all' })],
    ['a fractional dropped', () => ({ ...ready(), dropped: 0.5 })],
    ['a control-character alias', () => ready('a\u001bb')],
    ['a disabled source with an alias', () => ({ ...DISABLED, alias: 'x' })],
    ['an enabled source without an alias', () => ({ ...ready(), alias: null })],
    ['a no-data source with records', () => ({ ...ready(), state: 'no-data' })],
    ['a ready source with no records', () => ({ ...ready(), records: [] })],
    ['a record under another alias', () => ready('primary', [record('other')])],
    ['an invalid operation', () => ready('primary', [record('primary', 'list' as never)])],
    ['a duplicate operation', () => ready('primary', [record(), record()])],
    ['a negative counter', () => ready('primary', [{ ...record(), failed: -1 }])],
    ['a non-finite counter', () => ready('primary', [{ ...record(), ageMs: Infinity }])],
    ['a fractional duration', () => ready('primary', [{ ...record(), lastDurationMs: 1.5 }])],
    [
      'a duration on getSignedUrl',
      () => ready('primary', [{ ...record('primary', 'getSignedUrl'), lastDurationMs: 2 }]),
    ],
    [
      'bytes on a non-buffered operation',
      () => ready('primary', [{ ...record('primary', 'delete'), lastBytes: 4 }]),
    ],
    [
      'bytes on a record with no successful call',
      () => ready('primary', [{ ...record(), count: 1, succeeded: 0, failed: 1, lastBytes: 4 }]),
    ],
    [
      'a ready state whose freshest record is stale',
      () => ready('primary', [{ ...record(), ageMs: 30_001 }]),
    ],
    ['a stale state with a fresh record', () => ({ ...ready(), state: 'stale' })],
    [
      'an expired record',
      () => ({ ...ready('primary', [{ ...record(), ageMs: 60_000 }]), state: 'stale' }),
    ],
    [
      'a null duration on a timed operation',
      () => ready('primary', [{ ...record(), lastDurationMs: null }]),
    ],
    ['a count disagreeing with its outcomes', () => ready('primary', [{ ...record(), count: 3 }])],
    ['a throwing proxy', () =>
      new Proxy(ready(), {
        ownKeys: () => {
          throw new Error('trap-canary');
        },
      })],
  ];
  for (const [name, make] of invalid) {
    it(`isolates ${name} as a value-free collection-failed snapshot`, () => {
      expect(only(make())).toEqual(FAILED);
    });
  }

  it('accepts bytes on a mixed record whose last settlement succeeded', () => {
    const mixed = ready('primary', [{
      ...record(),
      count: 2,
      succeeded: 1,
      failed: 1,
      lastBytes: 4,
    }]);
    expect(only(mixed)).toEqual(mixed);
  });

  it('keeps a collection-failed source reporting its own approved alias', () => {
    const failed = { ...FAILED, alias: 'primary' };
    expect(only(failed)).toEqual(failed);
    expect(only({ ...DISABLED, state: 'ready', records: [record()] })).toEqual(FAILED);
  });

  it('accepts null duration and bytes, and a zero byte length', () => {
    const records = [
      { ...record('p', 'getSignedUrl'), lastDurationMs: null, lastBytes: null },
      { ...record('p', 'getStream'), lastBytes: null },
      { ...record('p', 'put'), lastBytes: 0 },
    ];
    expect(only(ready('p', records))).toEqual(ready('p', records));
  });

  it('never invokes a getter while copying', () => {
    let invoked = 0;
    const value = { ...ready() };
    Object.defineProperty(value, 'state', {
      get: () => {
        invoked++;
        return 'ready';
      },
      enumerable: true,
    });
    only(value);
    expect(invoked).toBe(0);
  });
});

describe('storage protocol — aggregate response', () => {
  it('answers unsupported with no sources', () => {
    const response = buildStorageResponse(TEST_INSTANCE_ID, []);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      sources: [],
    });
    expect(isStorageResponseProjection(response)).toBe(true);
  });

  it('assigns s1…sN ids in registration order and applies the state priority', () => {
    const cases: ReadonlyArray<[unknown[], string]> = [
      [[DISABLED, ready('a')], 'ready'],
      [[DISABLED, new Error('x')], 'collection-failed'],
      [[DISABLED, { ...ready('a', [{ ...record('a'), ageMs: 30_001 }]), state: 'stale' }], 'stale'],
      [[DISABLED, { ...ready('a'), state: 'no-data', records: [] }], 'no-data'],
      [[DISABLED, DISABLED], 'disabled'],
    ];
    for (const [values, state] of cases) {
      const response = buildStorageResponse(TEST_INSTANCE_ID, values.map(source));
      expect(response.state).toBe(state);
      expect((response.sources as { sourceId: string }[]).map((s) => s.sourceId)).toEqual([
        's1',
        's2',
      ]);
      expect(isStorageResponseProjection(response)).toBe(true);
    }
  });

  it('collapses duplicate non-null aliases to collection-failed with no sources', () => {
    const response = buildStorageResponse(TEST_INSTANCE_ID, [
      source(ready('same')),
      source(DISABLED),
      source(DISABLED),
      source(ready('same')),
    ]);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
    expect(isStorageResponseProjection(response)).toBe(true);
  });

  it('collapses a response over the 256 KiB budget rather than truncating it', () => {
    const ops = ['put', 'get', 'delete', 'exists', 'getSignedUrl', 'getStream'];
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const alias = `source-${i}`;
        return source(ready(alias, ops.map((op) => record(alias, op))));
      });
    // Positive control: sixteen full sources are far under the budget.
    expect(buildStorageResponse(TEST_INSTANCE_ID, make(16)).state).toBe('ready');
    expect(buildStorageResponse(TEST_INSTANCE_ID, make(1_000))).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
  });

  it('validator refuses malformed responses', () => {
    const good = buildStorageResponse(TEST_INSTANCE_ID, [source(ready())]);
    expect(isStorageResponseProjection(good)).toBe(true);
    const bad: unknown[] = [
      null,
      { ...good, extra: 1 },
      { ...good, version: 2 },
      { ...good, instanceId: '' },
      { ...good, sources: 'x' },
      { ...good, sources: [{ sourceId: 's2', snapshot: ready() }] },
      { ...good, sources: [{ sourceId: 's1', snapshot: ready(), x: 1 }] },
      { ...good, sources: [{ sourceId: 's1', snapshot: { ...ready(), state: 'bogus' } }] },
      {
        ...good,
        sources: [
          { sourceId: 's1', snapshot: ready('d') },
          { sourceId: 's2', snapshot: ready('d') },
        ],
      },
      { ...good, state: 'disabled' },
      {
        ...good,
        sources: Array.from(
          { length: 17 },
          (_, i) => ({ sourceId: `s${i + 1}`, snapshot: DISABLED }),
        ),
      },
      { ...good, sources: [{ sourceId: 's1', snapshot: DISABLED }], state: 'unsupported' },
    ];
    for (const value of bad) {
      expect(isStorageResponseProjection(value)).toBe(false);
    }
    expect(isStorageSnapshotProjection('x')).toBe(false);
  });
});

/** Decodes a handler response. */
function inspect(
  response: IResponse,
): { status: number; body: Record<string, unknown>; text: string } {
  const snapshot = response.snapshot();
  const text = new TextDecoder().decode(snapshot.body as Uint8Array);
  return { status: snapshot.status, body: JSON.parse(text), text };
}

/** Builds a handler over the given storage sources, bound to the test instance. */
async function harness(storageSources: readonly IStorageDiagnosticsSource[]) {
  const clock = new MutableClock();
  const session = await createTestSession(crypto.subtle, clock, 900_000);
  const key = await importTestKey(crypto.subtle);
  const handler = createConnectorHandler({
    port: TEST_PORT,
    subtle: crypto.subtle,
    session,
    limits: new ConnectorLimits(clock),
    queues: new QueueObservationMerger([], clock),
    traces: null,
    authorization: null,
    source: fakeSource(minimalSnapshot(), minimalBatch()),
    clock,
    healthSource: null,
    configSource: null,
    cacheSources: [],
    storageSources,
    schedulerSources: [],
    outboundHttpSources: [],
    eventSources: [],
    realtimeSources: [],
  });
  session.bindInstance(TEST_INSTANCE_ID);
  return { handler, key, clock, session };
}

/** One `/v1/storage` request's overridable parts. */
interface StorageRequestParts {
  readonly method?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly instance?: string;
  readonly mac?: string;
}

/** Sends a signed `/v1/storage` request; each part may be overridden. */
async function request(
  handler: (request: ReturnType<typeof fakeRequest>) => Promise<IResponse>,
  key: CryptoKey,
  parts: StorageRequestParts = {},
): Promise<IResponse> {
  const sequence = parts.sequence ?? 1;
  const instance = parts.instance ?? TEST_INSTANCE_ID;
  const mac = parts.mac ??
    await signRequest(crypto.subtle, key, '/v1/storage', sequence, instance);
  return await handler(fakeRequest({
    ...(parts.method !== undefined ? { method: parts.method } : {}),
    url: `http://${HOST}/v1/storage`,
    headers: {
      host: HOST,
      'x-setu-session': parts.sessionId ?? TEST_SESSION_ID,
      'x-setu-sequence': String(sequence),
      'x-setu-instance': instance,
      'x-setu-mac': mac,
    },
  }));
}

describe('connector — GET /v1/storage', () => {
  it('serves the aggregate response after authentication', async () => {
    const s = source(ready());
    const { handler, key } = await harness([s]);
    const view = inspect(await request(handler, key));
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot: ready() }],
    });
    expect(s.calls).toBe(1);
  });

  it('answers unsupported with no sources', async () => {
    const { handler, key } = await harness([]);
    expect(inspect(await request(handler, key)).body.state).toBe('unsupported');
  });

  it('reads no source when the request fails authentication', async () => {
    const s = source(ready());
    const { handler, key } = await harness([s]);
    const view = inspect(await request(handler, key, { mac: 'f'.repeat(64) }));
    expect(view.status).toBe(401);
    expect(s.calls).toBe(0);
  });

  const OTHER_INSTANCE = '00000000-0000-4000-8000-000000000000';
  // Every refusal the shared gate answers must precede the source read: each
  // row is sent against a fresh harness and must leave `calls` at 0.
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly status: number;
    readonly send: (h: Awaited<ReturnType<typeof harness>>) => Promise<IResponse>;
  }> = [
    {
      name: 'a replayed sequence',
      status: 401,
      send: async (h) => {
        expect((await request(h.handler, h.key)).snapshot().status).toBe(200);
        return await request(h.handler, h.key);
      },
    },
    {
      name: 'a request bound to another instance',
      status: 401,
      send: (h) => request(h.handler, h.key, { instance: OTHER_INSTANCE }),
    },
    {
      name: 'an unpaired session id',
      status: 401,
      send: (h) => request(h.handler, h.key, { sessionId: 'c'.repeat(32) }),
    },
    {
      name: 'an expired session',
      status: 401,
      send: (h) => {
        h.clock.advance(900_001);
        return request(h.handler, h.key);
      },
    },
    {
      name: 'a revoked session',
      status: 401,
      send: (h) => {
        h.session.revoke();
        return request(h.handler, h.key);
      },
    },
    {
      name: 'a mutation method',
      status: 400,
      send: (h) => request(h.handler, h.key, { method: 'POST' }),
    },
  ];
  for (const refusal of refusals) {
    it(`refuses ${refusal.name} without reading any source`, async () => {
      const s = source(ready());
      const h = await harness([s]);
      const view = inspect(await refusal.send(h));
      expect(view.status).toBe(refusal.status);
      expect(view.body).not.toHaveProperty('sources');
      // The replay row reads once for its first, legitimate request.
      expect(s.calls).toBe(refusal.name === 'a replayed sequence' ? 1 : 0);
    });
  }

  it('keeps a throwing source value-free on the wire', async () => {
    const { handler, key } = await harness([source(new Error('canary-throw-SYNTHETIC'))]);
    const view = inspect(await request(handler, key));
    expect(view.status).toBe(200);
    expect(view.body.state).toBe('collection-failed');
    expect(view.text).not.toContain('canary-throw-SYNTHETIC');
  });
});

describe('DiagnosticsPlugin — storage source bound', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-storage-sources',
      version: '0.0.0',
      register(ctx) {
        for (let i = 0; i < count; i++) {
          ctx.services.register<IStorageDiagnosticsSource>(
            CAPABILITIES.STORAGE_DIAGNOSTICS,
            source(DISABLED),
            { multi: true },
          );
        }
      },
    };
  }

  function port(): number {
    const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const value = (probe.addr as Deno.NetAddr).port;
    probe.close();
    return value;
  }

  function boot(count: number) {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: port(),
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
    const { app, started } = boot(MAX_STORAGE_SOURCES);
    await started;
    await app.stop();
  });

  it('refuses a 17th source with a fixed, value-free configuration error', async () => {
    const { app, started } = boot(MAX_STORAGE_SOURCES + 1);
    await expect(started).rejects.toThrow(PLUGIN_ERRORS.tooManyStorageSources);
    await app.stop().catch(() => {});
  });
});

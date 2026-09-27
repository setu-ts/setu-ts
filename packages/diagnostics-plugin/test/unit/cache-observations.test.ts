/**
 * Unit tests for the M98i cache operation: the copy-once source reader and
 * its refusals (getters, prototypes, extra keys, proxies, oversized lists,
 * duplicate aliases, budget overrun), the aggregate state priority, the ONE
 * wire validator, the authenticated `GET /v1/cache` dispatch (source reads
 * only after authentication, unsupported without sources), and the
 * connector's refusal of more than 16 sources at bootstrap.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  CacheDiagnosticsSnapshot,
  ICacheDiagnosticsSource,
  IPlugin,
  IResponse,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  buildCacheResponse,
  isCacheResponseProjection,
  isCacheSnapshotProjection,
  MAX_CACHE_SOURCES,
} from '../../src/protocol/cache-protocol.ts';
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

/** A well-formed record. */
function record(alias = 'primary', operation = 'get'): Record<string, unknown> {
  return {
    alias,
    operation,
    count: 1,
    lastDurationMs: 2,
    ageMs: 3,
    succeeded: 1,
    failed: 0,
    hits: 1,
    misses: 0,
    present: 0,
    absent: 0,
    removed: 0,
    notRemoved: 0,
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
function source(value: unknown): ICacheDiagnosticsSource & { calls: number } {
  const s = {
    calls: 0,
    snapshot(): CacheDiagnosticsSnapshot {
      s.calls++;
      if (value instanceof Error) {
        throw value;
      }
      return value as CacheDiagnosticsSnapshot;
    },
  };
  return s;
}

/** The one-source response's first snapshot. */
function only(value: unknown): unknown {
  const response = buildCacheResponse(TEST_INSTANCE_ID, [source(value)]);
  return (response.sources as { snapshot: unknown }[])[0]!.snapshot;
}

describe('cache protocol — target', () => {
  it('parses exactly /v1/cache with no query', () => {
    expect(parseTarget('/v1/cache', '')).toEqual({
      op: 'cache',
      canonicalTarget: '/v1/cache',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/cache', 'after=0&limit=1')).toBeNull();
    expect(parseTarget('/v1/cache/', '')).toBeNull();
  });
});

describe('cache protocol — source reading', () => {
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
    ['more than 64 records', () =>
      ready(
        'primary',
        Array.from({ length: 65 }, () => record()),
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
    ['an invalid operation', () => ready('primary', [record('primary', 'evict')])],
    ['a duplicate operation', () => ready('primary', [record(), record()])],
    ['a negative counter', () => ready('primary', [{ ...record(), failed: -1 }])],
    ['a non-finite counter', () => ready('primary', [{ ...record(), ageMs: Infinity }])],
    ['a fractional duration', () => ready('primary', [{ ...record(), lastDurationMs: 1.5 }])],
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

  it('keeps a collection-failed source reporting its own approved alias', () => {
    const failed = { ...FAILED, alias: 'primary' };
    expect(only(failed)).toEqual(failed);
    expect(only({ ...DISABLED, state: 'ready', records: [record()] })).toEqual(FAILED);
  });

  it('accepts a null lastDurationMs and snapshots at the record bound', () => {
    const ops = ['get', 'set', 'delete', 'has', 'clear'];
    const records = ops.map((op) => ({ ...record('p', op), lastDurationMs: null }));
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

describe('cache protocol — aggregate response', () => {
  it('answers unsupported with no sources', () => {
    const response = buildCacheResponse(TEST_INSTANCE_ID, []);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      sources: [],
    });
    expect(isCacheResponseProjection(response)).toBe(true);
  });

  it('assigns s1…sN ids in registration order and applies the state priority', () => {
    const cases: ReadonlyArray<[unknown[], string]> = [
      [[DISABLED, ready('a')], 'ready'],
      [[DISABLED, new Error('x')], 'collection-failed'],
      [[DISABLED, { ...ready('a'), state: 'stale' }], 'stale'],
      [[DISABLED, { ...ready('a'), state: 'no-data', records: [] }], 'no-data'],
      [[DISABLED, DISABLED], 'disabled'],
    ];
    for (const [values, state] of cases) {
      const response = buildCacheResponse(TEST_INSTANCE_ID, values.map(source));
      expect(response.state).toBe(state);
      expect((response.sources as { sourceId: string }[]).map((s) => s.sourceId)).toEqual([
        's1',
        's2',
      ]);
      expect(isCacheResponseProjection(response)).toBe(true);
    }
  });

  it('collapses duplicate non-null aliases to collection-failed with no sources', () => {
    const response = buildCacheResponse(TEST_INSTANCE_ID, [
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
    expect(isCacheResponseProjection(response)).toBe(true);
  });

  it('collapses a response over the 256 KiB budget rather than truncating it', () => {
    const ops = ['get', 'set', 'delete', 'has', 'clear'];
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const alias = `source-${i}`;
        return source(ready(alias, ops.map((op) => record(alias, op))));
      });
    // Positive control: sixteen full sources are far under the budget.
    expect(buildCacheResponse(TEST_INSTANCE_ID, make(16)).state).toBe('ready');
    expect(buildCacheResponse(TEST_INSTANCE_ID, make(1_000))).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
  });

  it('validator refuses malformed responses', () => {
    const good = buildCacheResponse(TEST_INSTANCE_ID, [source(ready())]);
    expect(isCacheResponseProjection(good)).toBe(true);
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
      expect(isCacheResponseProjection(value)).toBe(false);
    }
    expect(isCacheSnapshotProjection('x')).toBe(false);
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

/** Builds a handler over the given cache sources, bound to the test instance. */
async function harness(cacheSources: readonly ICacheDiagnosticsSource[]) {
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
    source: fakeSource(minimalSnapshot(), minimalBatch()),
    clock,
    healthSource: null,
    configSource: null,
    cacheSources,
  });
  session.bindInstance(TEST_INSTANCE_ID);
  return { handler, key };
}

/** Sends a signed `/v1/cache` request, optionally with a wrong MAC. */
async function request(
  handler: (request: ReturnType<typeof fakeRequest>) => Promise<IResponse>,
  key: CryptoKey,
  mac?: string,
): Promise<IResponse> {
  const signed = mac ?? await signRequest(crypto.subtle, key, '/v1/cache', 1, TEST_INSTANCE_ID);
  return await handler(fakeRequest({
    url: `http://${HOST}/v1/cache`,
    headers: {
      host: HOST,
      'x-setu-session': TEST_SESSION_ID,
      'x-setu-sequence': '1',
      'x-setu-instance': TEST_INSTANCE_ID,
      'x-setu-mac': signed,
    },
  }));
}

describe('connector — GET /v1/cache', () => {
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
    const view = inspect(await request(handler, key, 'f'.repeat(64)));
    expect(view.status).toBe(401);
    expect(s.calls).toBe(0);
  });

  it('keeps a throwing source value-free on the wire', async () => {
    const { handler, key } = await harness([source(new Error('canary-throw-SYNTHETIC'))]);
    const view = inspect(await request(handler, key));
    expect(view.status).toBe(200);
    expect(view.body.state).toBe('collection-failed');
    expect(view.text).not.toContain('canary-throw-SYNTHETIC');
  });
});

describe('DiagnosticsPlugin — cache source bound', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-cache-sources',
      version: '0.0.0',
      register(ctx) {
        for (let i = 0; i < count; i++) {
          ctx.services.register<ICacheDiagnosticsSource>(
            CAPABILITIES.CACHE_DIAGNOSTICS,
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
    const { app, started } = boot(MAX_CACHE_SOURCES);
    await started;
    await app.stop();
  });

  it('refuses a 17th source with a fixed, value-free configuration error', async () => {
    const { app, started } = boot(MAX_CACHE_SOURCES + 1);
    await expect(started).rejects.toThrow(PLUGIN_ERRORS.tooManyCacheSources);
    await app.stop().catch(() => {});
  });
});

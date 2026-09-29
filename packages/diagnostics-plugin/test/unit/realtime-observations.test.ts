/**
 * Unit tests for the M98l realtime operation: the copy-once source reader and
 * its refusals — getters, prototypes, extra keys, proxies, oversized lists,
 * and the kind/operation, kind/gauge and state/gauge combinations the contract
 * fixes — the synthetic `unknown` snapshot, duplicate aliases, budget overrun,
 * the aggregate state priority, the ONE wire validator, the authenticated
 * `GET /v1/realtime` dispatch (no source or gauge read before
 * authentication), and the connector's refusal of more than 16 sources.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  IPlugin,
  IRealtimeDiagnosticsSource,
  IResponse,
  RealtimeDiagnosticsSnapshot,
} from '@setu-ts/common';
import { CAPABILITIES, createRealtimeObservationCollector } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  buildRealtimeResponse,
  isRealtimeResponseProjection,
  isRealtimeSnapshotProjection,
  MAX_REALTIME_SOURCES,
} from '../../src/protocol/realtime-protocol.ts';
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
function record(
  alias: string,
  operation: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    alias,
    operation,
    count: 2,
    lastDurationMs: null,
    ageMs: 3,
    succeeded: 1,
    failed: 1,
    backpressureCloses: null,
    ...extra,
  };
}

function available(openConnections = 2, groups = 1): Record<string, unknown> {
  return { state: 'available', openConnections, groups };
}

const UNREAD = {
  unsupported: { state: 'unsupported', openConnections: null, groups: null },
  disabled: { state: 'disabled', openConnections: null, groups: null },
  failed: { state: 'collection-failed', openConnections: null, groups: null },
} as const;

function websocket(alias = 'chat', records = [record(alias, 'send')]): Record<string, unknown> {
  return {
    state: 'ready',
    alias,
    sourceKind: 'websocket',
    coverage: 'owned-instance',
    gauges: available(),
    records,
    dropped: 0,
  };
}

function sse(alias = 'feed'): Record<string, unknown> {
  return {
    ...websocket(alias, [record(alias, 'close', { backpressureCloses: 1 })]),
    sourceKind: 'sse',
  };
}

function backplane(
  alias = 'fanout',
  records = [record(alias, 'backplane-publish', { lastDurationMs: 4 })],
): Record<string, unknown> {
  return {
    state: 'ready',
    alias,
    sourceKind: 'backplane',
    coverage: 'owned-instance',
    gauges: { ...UNREAD.unsupported },
    records,
    dropped: 0,
  };
}

function disabled(kind = 'websocket'): Record<string, unknown> {
  return {
    state: 'disabled',
    alias: null,
    sourceKind: kind,
    coverage: 'owned-instance',
    gauges: { ...UNREAD.disabled },
    records: [],
    dropped: 0,
  };
}

const SYNTHETIC = {
  state: 'collection-failed',
  alias: null,
  sourceKind: 'unknown',
  coverage: 'owned-instance',
  gauges: { state: 'collection-failed', openConnections: null, groups: null },
  records: [],
  dropped: 0,
};

/** A source answering `value` (or throwing it when it is an Error). */
function source(value: unknown): IRealtimeDiagnosticsSource & { calls: number } {
  const s = {
    calls: 0,
    snapshot(): RealtimeDiagnosticsSnapshot {
      s.calls++;
      if (value instanceof Error) {
        throw value;
      }
      return value as RealtimeDiagnosticsSnapshot;
    },
  };
  return s;
}

/** The one-source response's first snapshot. */
function only(value: unknown): unknown {
  const response = buildRealtimeResponse(TEST_INSTANCE_ID, [source(value)]);
  return (response.sources as { snapshot: unknown }[])[0]!.snapshot;
}

describe('realtime protocol — target', () => {
  it('parses exactly /v1/realtime with no query', () => {
    expect(parseTarget('/v1/realtime', '')).toEqual({
      op: 'realtime',
      canonicalTarget: '/v1/realtime',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/realtime', 'after=0&limit=1')).toBeNull();
    expect(parseTarget('/v1/realtime/', '')).toBeNull();
  });
});

describe('realtime protocol — source reading', () => {
  it('copies every well-formed kind and state (positive controls)', () => {
    const valid: unknown[] = [
      websocket(),
      websocket('chat', []),
      sse(),
      backplane(),
      { ...backplane(), state: 'stale' },
      { ...backplane('fanout', []), state: 'no-data' },
      backplane('fanout', [record('fanout', 'backplane-receive')]),
      disabled('websocket'),
      disabled('sse'),
      disabled('backplane'),
      { ...disabled('sse'), state: 'collection-failed', gauges: { ...UNREAD.failed } },
      {
        ...disabled('backplane'),
        state: 'collection-failed',
        alias: 'fanout',
        gauges: { ...UNREAD.failed },
      },
      websocket('chat', [record('chat', 'open'), record('chat', 'close'), record('chat', 'send')]),
      Object.assign(Object.create(null), websocket()),
      { ...websocket(), gauges: Object.assign(Object.create(null), available(0, 0)) },
    ];
    for (const value of valid) {
      expect(only(value)).toEqual({ ...(value as Record<string, unknown>) });
    }
  });

  it('reads a real collector end to end', () => {
    const collector = createRealtimeObservationCollector({
      kind: 'sse',
      alias: 'feed',
      clock: () => 5,
      gauges: () => ({ openConnections: 4, groups: 2 }),
    });
    collector.observe('close', false, true);
    expect(only(collector.source.snapshot())).toEqual({
      state: 'ready',
      alias: 'feed',
      sourceKind: 'sse',
      coverage: 'owned-instance',
      gauges: { state: 'available', openConnections: 4, groups: 2 },
      records: [record('feed', 'close', {
        count: 1,
        ageMs: 0,
        succeeded: 0,
        failed: 1,
        backpressureCloses: 1,
      })],
      dropped: 0,
    });
  });

  const invalid: ReadonlyArray<[string, () => unknown]> = [
    ['a thrown error', () => new Error('canary-source-SYNTHETIC')],
    ['a non-object', () => 'ready'],
    ['a class instance', () => Object.assign(new (class Snapshot {})(), websocket())],
    ['an extra key', () => ({ ...websocket(), room: 'canary' })],
    ['a symbol key', () => ({ ...websocket(), [Symbol('x')]: 1 })],
    ['a getter', () => {
      const value = { ...websocket() };
      Object.defineProperty(value, 'alias', { get: () => 'chat', enumerable: true });
      return value;
    }],
    ['a gauge getter', () => {
      const gauges = available();
      Object.defineProperty(gauges, 'groups', { get: () => 1, enumerable: true });
      return { ...websocket(), gauges };
    }],
    ['gauges with an extra key', () => ({ ...websocket(), gauges: { ...available(), x: 1 } })],
    ['a non-object gauges', () => ({ ...websocket(), gauges: 'available' })],
    ['an unknown gauge state', () => ({ ...websocket(), gauges: { ...available(), state: 'on' } })],
    ['a claimed unknown kind', () => ({ ...SYNTHETIC })],
    ['an invented kind', () => ({ ...websocket(), sourceKind: 'grpc' })],
    ['an unsupported source state', () => ({ ...websocket(), state: 'unsupported' })],
    ['a websocket reporting no-data', () => ({ ...websocket('chat', []), state: 'no-data' })],
    ['an sse reporting stale', () => ({ ...sse(), state: 'stale' })],
    ['numeric backplane gauges', () => ({ ...backplane(), gauges: available() })],
    ['unsupported websocket gauges', () => ({ ...websocket(), gauges: { ...UNREAD.unsupported } })],
    ['null available gauges', () => ({ ...websocket(), gauges: available(null as never) })],
    ['a negative gauge', () => ({ ...websocket(), gauges: available(-1) })],
    ['a fractional gauge', () => ({ ...websocket(), gauges: available(1, 0.5) })],
    ['numbers on an unread gauge', () => ({
      ...backplane(),
      gauges: { state: 'unsupported', openConnections: 0, groups: 0 },
    })],
    ['a disabled source with available gauges', () => ({ ...disabled(), gauges: available() })],
    ['a failed source with disabled gauges', () => ({
      ...disabled(),
      state: 'collection-failed',
    })],
    ['a disabled source with an alias', () => ({ ...disabled(), alias: 'x' })],
    ['an enabled source without an alias', () => ({ ...websocket(), alias: null })],
    ['a control-character alias', () => websocket('a\u001bb', [])],
    ['a disabled source with records', () => ({
      ...disabled(),
      records: [record('chat', 'send')],
    })],
    ['a ready backplane with no records', () => backplane('fanout', [])],
    ['a no-data backplane with records', () => ({ ...backplane(), state: 'no-data' })],
    ['a record under another alias', () => websocket('chat', [record('other', 'send')])],
    [
      'a backplane operation on a websocket',
      () => websocket('chat', [record('chat', 'backplane-publish')]),
    ],
    ['a websocket operation on a backplane', () => backplane('fanout', [record('fanout', 'send')])],
    [
      'a duplicate operation',
      () => websocket('chat', [record('chat', 'send'), record('chat', 'send')]),
    ],
    [
      'a backpressure count on a websocket close',
      () => websocket('chat', [record('chat', 'close', { backpressureCloses: 0 })]),
    ],
    ['a backpressure count on an sse send', () => ({
      ...sse(),
      records: [record('feed', 'send', { backpressureCloses: 0 })],
    })],
    ['a null backpressure count on an sse close', () => ({
      ...sse(),
      records: [record('feed', 'close')],
    })],
    [
      'a duration on a send',
      () => websocket('chat', [record('chat', 'send', { lastDurationMs: 1 })]),
    ],
    [
      'a duration on a receive',
      () => backplane('fanout', [record('fanout', 'backplane-receive', { lastDurationMs: 1 })]),
    ],
    [
      'a fractional publish duration',
      () => backplane('fanout', [record('fanout', 'backplane-publish', { lastDurationMs: 1.5 })]),
    ],
    ['a negative counter', () => websocket('chat', [record('chat', 'send', { failed: -1 })])],
    ['a non-finite age', () => websocket('chat', [record('chat', 'send', { ageMs: Infinity })])],
    ['an extra record key', () => websocket('chat', [record('chat', 'send', { id: 'x' })])],
    ['a non-array records', () => ({ ...websocket(), records: { length: 0 } })],
    [
      'more than 64 records',
      () => websocket('chat', Array.from({ length: 65 }, () => record('chat', 'send'))),
    ],
    ['a fractional dropped', () => ({ ...websocket(), dropped: 0.5 })],
    ['a wrong coverage', () => ({ ...websocket(), coverage: 'cluster' })],
    ['a throwing proxy', () =>
      new Proxy(websocket(), {
        ownKeys: () => {
          throw new Error('trap-canary');
        },
      })],
  ];
  for (const [name, make] of invalid) {
    it(`isolates ${name} as the value-free unknown snapshot`, () => {
      expect(only(make())).toEqual(SYNTHETIC);
    });
  }

  it('never invokes a getter while copying', () => {
    let invoked = 0;
    const value = { ...websocket() };
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

  it('the snapshot validator admits unknown only on the wire, and only the exact synthetic shape', () => {
    expect(isRealtimeSnapshotProjection(SYNTHETIC, false)).toBe(false);
    expect(isRealtimeSnapshotProjection(SYNTHETIC, true)).toBe(true);
    const variants: unknown[] = [
      { ...SYNTHETIC, alias: 'x' },
      { ...SYNTHETIC, state: 'disabled' },
      { ...SYNTHETIC, dropped: 1 },
      { ...SYNTHETIC, coverage: 'all' },
      { ...SYNTHETIC, records: [record('x', 'send')] },
      { ...SYNTHETIC, gauges: { ...UNREAD.disabled } },
      { ...SYNTHETIC, gauges: { state: 'collection-failed', openConnections: 0, groups: null } },
      { ...SYNTHETIC, gauges: { state: 'collection-failed', openConnections: null, groups: 0 } },
      { ...SYNTHETIC, gauges: { ...UNREAD.failed, extra: 1 } },
      { ...SYNTHETIC, gauges: null },
    ];
    for (const variant of variants) {
      expect(isRealtimeSnapshotProjection(variant, true)).toBe(false);
    }
    expect(isRealtimeSnapshotProjection('x', true)).toBe(false);
  });
});

describe('realtime protocol — aggregate response', () => {
  it('answers unsupported with no sources', () => {
    const response = buildRealtimeResponse(TEST_INSTANCE_ID, []);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      sources: [],
    });
    expect(isRealtimeResponseProjection(response)).toBe(true);
  });

  it('assigns s1…sN ids in registration order and applies the state priority', () => {
    const cases: ReadonlyArray<[unknown[], string]> = [
      [[disabled(), websocket()], 'ready'],
      [[disabled(), new Error('x')], 'collection-failed'],
      [[disabled(), { ...backplane(), state: 'stale' }], 'stale'],
      [[disabled(), { ...backplane('fanout', []), state: 'no-data' }], 'no-data'],
      [[disabled(), disabled('sse')], 'disabled'],
    ];
    for (const [values, state] of cases) {
      const response = buildRealtimeResponse(TEST_INSTANCE_ID, values.map(source));
      expect(response.state).toBe(state);
      expect((response.sources as { sourceId: string }[]).map((s) => s.sourceId)).toEqual([
        's1',
        's2',
      ]);
      expect(isRealtimeResponseProjection(response)).toBe(true);
    }
  });

  it('keeps each source kind visible, including the synthetic unknown', () => {
    const response = buildRealtimeResponse(TEST_INSTANCE_ID, [
      source(websocket()),
      source(sse()),
      source(backplane()),
      source(new Error('x')),
    ]);
    expect(
      (response.sources as { snapshot: { sourceKind: string } }[]).map((s) =>
        s.snapshot.sourceKind
      ),
    ).toEqual(['websocket', 'sse', 'backplane', 'unknown']);
    expect(isRealtimeResponseProjection(response)).toBe(true);
  });

  it('collapses duplicate non-null aliases to collection-failed with no sources', () => {
    const response = buildRealtimeResponse(TEST_INSTANCE_ID, [
      source(websocket('same')),
      source(disabled()),
      source(backplane('same')),
    ]);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
    expect(isRealtimeResponseProjection(response)).toBe(true);
  });

  it('collapses a response over the 256 KiB budget rather than truncating it', () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const alias = `source-${i}`;
        return source(websocket(alias, [
          record(alias, 'open'),
          record(alias, 'close'),
          record(alias, 'send'),
        ]));
      });
    // Positive control: sixteen full sources are far under the budget.
    expect(buildRealtimeResponse(TEST_INSTANCE_ID, make(16)).state).toBe('ready');
    expect(buildRealtimeResponse(TEST_INSTANCE_ID, make(1_000))).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
  });

  it('the wire validator refuses malformed responses', () => {
    const good = buildRealtimeResponse(TEST_INSTANCE_ID, [source(websocket())]);
    expect(isRealtimeResponseProjection(good)).toBe(true);
    const bad: unknown[] = [
      null,
      { ...good, extra: 1 },
      { ...good, version: 2 },
      { ...good, instanceId: '' },
      { ...good, sources: 'x' },
      { ...good, sources: [{ sourceId: 's2', snapshot: websocket() }] },
      { ...good, sources: [{ sourceId: 's1', snapshot: websocket(), x: 1 }] },
      { ...good, sources: [{ sourceId: 's1', snapshot: { ...websocket(), sourceKind: 'x' } }] },
      {
        ...good,
        sources: [
          { sourceId: 's1', snapshot: websocket('d') },
          { sourceId: 's2', snapshot: sse('d') },
        ],
      },
      { ...good, state: 'disabled' },
      {
        ...good,
        sources: Array.from({ length: 17 }, (_, i) => ({
          sourceId: `s${i + 1}`,
          snapshot: disabled(),
        })),
      },
      { ...good, sources: [{ sourceId: 's1', snapshot: disabled() }], state: 'unsupported' },
    ];
    for (const value of bad) {
      expect(isRealtimeResponseProjection(value)).toBe(false);
    }
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

/** Builds a handler over the given realtime sources, bound to the test instance. */
async function harness(realtimeSources: readonly IRealtimeDiagnosticsSource[]) {
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
    storageSources: [],
    eventSources: [],
    realtimeSources,
  });
  session.bindInstance(TEST_INSTANCE_ID);
  return { handler, key, clock, session };
}

/** One `/v1/realtime` request's overridable parts. */
interface RealtimeRequestParts {
  readonly method?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly instance?: string;
  readonly mac?: string;
  readonly origin?: string;
  readonly host?: string;
}

/** Sends a signed `/v1/realtime` request; each part may be overridden. */
async function request(
  handler: (request: ReturnType<typeof fakeRequest>) => Promise<IResponse>,
  key: CryptoKey,
  parts: RealtimeRequestParts = {},
): Promise<IResponse> {
  const sequence = parts.sequence ?? 1;
  const instance = parts.instance ?? TEST_INSTANCE_ID;
  const mac = parts.mac ??
    await signRequest(crypto.subtle, key, '/v1/realtime', sequence, instance);
  return await handler(fakeRequest({
    ...(parts.method !== undefined ? { method: parts.method } : {}),
    url: `http://${HOST}/v1/realtime`,
    headers: {
      host: parts.host ?? HOST,
      'x-setu-session': parts.sessionId ?? TEST_SESSION_ID,
      'x-setu-sequence': String(sequence),
      'x-setu-instance': instance,
      'x-setu-mac': mac,
      ...(parts.origin !== undefined ? { origin: parts.origin } : {}),
    },
  }));
}

describe('connector — GET /v1/realtime', () => {
  it('serves the aggregate response after authentication', async () => {
    const s = source(websocket());
    const { handler, key } = await harness([s]);
    const view = inspect(await request(handler, key));
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot: websocket() }],
    });
    expect(s.calls).toBe(1);
  });

  it('answers unsupported with no sources', async () => {
    const { handler, key } = await harness([]);
    expect(inspect(await request(handler, key)).body.state).toBe('unsupported');
  });

  it('never calls a gauge reader when the request fails authentication', async () => {
    let gaugeReads = 0;
    const collector = createRealtimeObservationCollector({
      kind: 'websocket',
      alias: 'chat',
      clock: () => 1,
      gauges: () => {
        gaugeReads++;
        return { openConnections: 0, groups: 0 };
      },
    });
    const { handler, key } = await harness([collector.source]);
    expect(inspect(await request(handler, key, { mac: 'f'.repeat(64) })).status).toBe(401);
    expect(gaugeReads).toBe(0);
    expect(inspect(await request(handler, key)).status).toBe(200);
    expect(gaugeReads).toBe(1);
  });

  const OTHER_INSTANCE = '00000000-0000-4000-8000-000000000000';
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
    {
      name: 'a browser origin',
      status: 400,
      send: (h) => request(h.handler, h.key, { origin: 'https://example.com' }),
    },
    {
      name: 'a rebinding host',
      status: 400,
      send: (h) => request(h.handler, h.key, { host: `rebind.example:${TEST_PORT}` }),
    },
  ];
  for (const refusal of refusals) {
    it(`refuses ${refusal.name} without reading any source`, async () => {
      const s = source(websocket());
      const h = await harness([s]);
      const view = inspect(await refusal.send(h));
      expect(view.status).toBeGreaterThanOrEqual(400);
      expect(view.body).not.toHaveProperty('sources');
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

describe('DiagnosticsPlugin — realtime source bound', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-realtime-sources',
      version: '0.0.0',
      register(ctx) {
        for (let i = 0; i < count; i++) {
          ctx.services.register<IRealtimeDiagnosticsSource>(
            CAPABILITIES.REALTIME_DIAGNOSTICS,
            source(disabled()),
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
    const { app, started } = boot(MAX_REALTIME_SOURCES);
    await started;
    await app.stop();
  });

  it('refuses a 17th source with a fixed, value-free configuration error', async () => {
    const { app, started } = boot(MAX_REALTIME_SOURCES + 1);
    await expect(started).rejects.toThrow(PLUGIN_ERRORS.tooManyRealtimeSources);
    await app.stop().catch(() => {});
  });
});

/**
 * Unit tests for the M98n outbound HTTP operation: the copy-once source
 * reader and its refusals (getters, prototypes, extra keys, proxies, lists
 * over one record, every counting invariant, forged states), duplicate
 * aliases, the budget collapse, the aggregate state, the ONE wire validator,
 * the authenticated `GET /v1/outbound-http` dispatch (no source read before
 * authentication), the manifest, and the 16-source bootstrap bound.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IOutboundHttpDiagnosticsSource, IPlugin, IResponse } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  buildOutboundHttpResponse,
  isOutboundHttpResponseProjection,
  isOutboundHttpSnapshotProjection,
  MAX_OUTBOUND_HTTP_SOURCES,
} from '../../src/protocol/outbound-http-protocol.ts';
import { currentInspectorsManifest, parseTarget } from '../../src/protocol/protocol.ts';
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

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: 'payments',
    operation: 'attempt',
    started: 3,
    count: 2,
    responses: 1,
    failures: 1,
    lastStatusClass: '2xx',
    lastDurationMs: 12,
    ageMs: 4,
    ...extra,
  };
}

function ready(extra: Record<string, unknown> = {}, alias = 'payments'): Record<string, unknown> {
  return {
    state: 'ready',
    alias,
    coverage: 'owned-instance',
    records: [record({ alias })],
    ...extra,
  };
}

function noData(alias = 'payments'): Record<string, unknown> {
  return { state: 'no-data', alias, coverage: 'owned-instance', records: [] };
}

function disabled(): Record<string, unknown> {
  return { state: 'disabled', alias: null, coverage: 'owned-instance', records: [] };
}

/** A source serving a fixed value (or throwing), counting its reads. */
function source(value: unknown): IOutboundHttpDiagnosticsSource & { calls: number } {
  return {
    calls: 0,
    snapshot() {
      this.calls++;
      if (value instanceof Error) {
        throw value;
      }
      return value as never;
    },
  };
}

const FAILED = { state: 'collection-failed', alias: null, coverage: 'owned-instance', records: [] };

function only(value: unknown): Record<string, unknown> {
  const response = buildOutboundHttpResponse(TEST_INSTANCE_ID, [source(value)]);
  return (response.sources as { snapshot: Record<string, unknown> }[])[0]!.snapshot;
}

describe('outbound HTTP protocol — snapshot reader', () => {
  it('admits a well-formed ready, stale, no-data and disabled snapshot', () => {
    expect(only(ready())).toEqual(ready());
    expect(only(ready({ state: 'stale' }))).toEqual(ready({ state: 'stale' }));
    expect(only(noData())).toEqual(noData());
    expect(only(disabled())).toEqual(disabled());
  });

  const hostile: readonly [string, () => unknown][] = [
    [
      'a getter',
      () => Object.defineProperty(ready(), 'state', { get: () => 'ready', enumerable: true }),
    ],
    ['a custom prototype', () => Object.assign(Object.create({ x: 1 }), ready())],
    ['a class instance', () =>
      new (class {
        state = 'ready';
        alias = 'payments';
        coverage = 'owned-instance';
        records = [];
      })()],
    ['an extra key', () => ({ ...ready(), dropped: 0 })],
    ['a symbol key', () => ({ ...ready(), [Symbol('x')]: 1 })],
    ['a throwing proxy', () =>
      new Proxy(ready(), {
        ownKeys: () => {
          throw new Error('trap');
        },
      })],
    ['two records', () => ready({ records: [record(), record()] })],
    [
      'a record with an extra key',
      () => ready({ records: [{ ...record(), url: 'https://canary' }] }),
    ],
    [
      'a record getter',
      () =>
        ready({
          records: [Object.defineProperty(record(), 'count', { get: () => 2, enumerable: true })],
        }),
    ],
    ['a wrong operation', () => ready({ records: [record({ operation: 'request' })] })],
    ['a mismatched record alias', () => ready({ records: [record({ alias: 'other' })] })],
    ['count above started', () => ready({ records: [record({ started: 1, count: 2 })] })],
    ['responses + failures != count', () => ready({ records: [record({ failures: 0 })] })],
    [
      'a status class with no response',
      () => ready({ records: [record({ responses: 0, failures: 2 })] }),
    ],
    [
      'no status class with a response',
      () => ready({ records: [record({ lastStatusClass: null })] }),
    ],
    ['a raw status number', () => ready({ records: [record({ lastStatusClass: 404 })] })],
    ['an unknown status class', () => ready({ records: [record({ lastStatusClass: '1xx' })] })],
    [
      'a duration with no settlement',
      () =>
        ready({
          records: [
            record({ started: 1, count: 0, responses: 0, failures: 0, lastStatusClass: null }),
          ],
        }),
    ],
    [
      'no duration after a settlement',
      () => ready({ records: [record({ lastDurationMs: null })] }),
    ],
    ['a NaN counter', () => ready({ records: [record({ ageMs: Number.NaN })] })],
    ['a negative counter', () => ready({ records: [record({ started: -1 })] })],
    ['a fractional counter', () => ready({ records: [record({ lastDurationMs: 1.5 })] })],
    [
      'an unsafe counter',
      () => ready({ records: [record({ started: Number.MAX_SAFE_INTEGER + 2 })] }),
    ],
    ['ready with no record', () => ready({ records: [] })],
    ['no-data with a record', () => noData() && { ...noData(), records: [record()] }],
    ['disabled with an alias', () => ({ ...disabled(), alias: 'payments' })],
    ['a source-reported unsupported', () => ({ ...noData(), state: 'unsupported' })],
    ['an unknown coverage', () => ready({ coverage: 'process' })],
    ['a control-character alias', () => ready({}, 'bad\nalias')],
    ['a 65-byte alias', () => ready({}, 'x'.repeat(65))],
    ['a non-array records', () => ready({ records: { 0: record(), length: 1 } })],
    ['a null snapshot', () => null],
  ];
  for (const [label, build] of hostile) {
    it(`reduces ${label} to the fixed value-free failed snapshot`, () => {
      expect(only(build())).toEqual(FAILED);
    });
  }

  it('reduces a throwing source to the fixed failed snapshot without its error text', () => {
    const response = buildOutboundHttpResponse(TEST_INSTANCE_ID, [
      source(new Error('canary-SYNTHETIC')),
    ]);
    expect(JSON.stringify(response)).not.toContain('canary-SYNTHETIC');
    expect(response.state).toBe('collection-failed');
  });

  it('never invokes a getter on the source snapshot', () => {
    let reads = 0;
    const snapshot = ready();
    Object.defineProperty(snapshot, 'alias', {
      get() {
        reads++;
        return 'payments';
      },
      enumerable: true,
    });
    only(snapshot);
    expect(reads).toBe(0);
  });
});

describe('outbound HTTP protocol — aggregate response', () => {
  it('assigns s1..sN and aggregates ready above the other states', () => {
    const response = buildOutboundHttpResponse(TEST_INSTANCE_ID, [
      source(noData('a')),
      source(ready({}, 'b')),
      source(disabled()),
    ]);
    expect(response.state).toBe('ready');
    expect((response.sources as { sourceId: string }[]).map((entry) => entry.sourceId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(isOutboundHttpResponseProjection(response)).toBe(true);
  });

  it('orders collection-failed, stale, no-data, disabled; no source is unsupported', () => {
    const state = (values: unknown[]) =>
      buildOutboundHttpResponse(TEST_INSTANCE_ID, values.map(source)).state;
    expect(state([noData('a'), new Error('x')])).toBe('collection-failed');
    expect(state([noData('a'), ready({ state: 'stale' }, 'b')])).toBe('stale');
    expect(state([disabled(), noData('a')])).toBe('no-data');
    expect(state([disabled()])).toBe('disabled');
    expect(state([])).toBe('unsupported');
  });

  it('collapses duplicate non-null aliases to a value-free collection-failed', () => {
    const response = buildOutboundHttpResponse(TEST_INSTANCE_ID, [
      source(ready()),
      source(noData()),
    ]);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
    expect(isOutboundHttpResponseProjection(response)).toBe(true);
  });

  it('collapses an over-budget response rather than truncating it', () => {
    const response = buildOutboundHttpResponse(TEST_INSTANCE_ID, [source(ready())], 64);
    expect(response.sources).toEqual([]);
    expect(response.state).toBe('collection-failed');
  });
});

describe('outbound HTTP protocol — wire validator', () => {
  const good = {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    sources: [{ sourceId: 's1', snapshot: ready() }],
  };
  it('accepts a well-formed response', () => {
    expect(isOutboundHttpResponseProjection(good)).toBe(true);
    expect(isOutboundHttpSnapshotProjection(ready())).toBe(true);
  });
  const bad: readonly unknown[] = [
    null,
    { ...good, extra: 1 },
    { ...good, version: 2 },
    { ...good, instanceId: '' },
    { ...good, sources: 'x' },
    { ...good, state: 'stale' },
    { ...good, sources: [{ sourceId: 's2', snapshot: ready() }] },
    { ...good, sources: [{ sourceId: 's1', snapshot: ready(), extra: 1 }] },
    {
      ...good,
      sources: [{ sourceId: 's1', snapshot: { ...ready(), records: [record({ count: 9 })] } }],
    },
    {
      ...good,
      sources: [
        { sourceId: 's1', snapshot: ready() },
        { sourceId: 's2', snapshot: noData() },
      ],
    },
    {
      ...good,
      state: 'disabled',
      sources: Array.from({ length: MAX_OUTBOUND_HTTP_SOURCES + 1 }, (_, i) => ({
        sourceId: `s${i + 1}`,
        snapshot: disabled(),
      })),
    },
  ];
  for (const [index, value] of bad.entries()) {
    it(`refuses malformed response #${index}`, () => {
      expect(isOutboundHttpResponseProjection(value)).toBe(false);
    });
  }
});

describe('outbound HTTP protocol — target and manifest', () => {
  it('parses only the exact canonical target', () => {
    expect(parseTarget('/v1/outbound-http', '')?.op).toBe('outbound-http');
    expect(parseTarget('/v1/outbound-http/', '')).toBe(null);
    expect(parseTarget('/v1/outbound-http', 'x=1')).toBe(null);
    expect(parseTarget('/v1/outbound%2Dhttp', '')).toBe(null);
  });

  it('advertises outboundHttp in the manifest', () => {
    expect(currentInspectorsManifest().outboundHttp).toBe(true);
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

async function harness(outboundHttpSources: readonly IOutboundHttpDiagnosticsSource[]) {
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
    eventSources: [],
    realtimeSources: [],
    outboundHttpSources,
  });
  session.bindInstance(TEST_INSTANCE_ID);
  return { handler, key, clock, session };
}

interface RequestParts {
  readonly method?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly instance?: string;
  readonly mac?: string;
  readonly origin?: string;
  readonly host?: string;
  readonly forwarded?: boolean;
}

async function request(
  handler: (request: ReturnType<typeof fakeRequest>) => Promise<IResponse>,
  key: CryptoKey,
  parts: RequestParts = {},
): Promise<IResponse> {
  const sequence = parts.sequence ?? 1;
  const instance = parts.instance ?? TEST_INSTANCE_ID;
  const mac = parts.mac ??
    await signRequest(crypto.subtle, key, '/v1/outbound-http', sequence, instance);
  return await handler(fakeRequest({
    ...(parts.method !== undefined ? { method: parts.method } : {}),
    url: `http://${HOST}/v1/outbound-http`,
    headers: {
      host: parts.host ?? HOST,
      'x-setu-session': parts.sessionId ?? TEST_SESSION_ID,
      'x-setu-sequence': String(sequence),
      'x-setu-instance': instance,
      'x-setu-mac': mac,
      ...(parts.origin !== undefined ? { origin: parts.origin } : {}),
      ...(parts.forwarded === true ? { 'x-forwarded-for': '10.0.0.1' } : {}),
    },
  }));
}

describe('connector — GET /v1/outbound-http', () => {
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
    const view = inspect(await request(handler, key));
    expect(view.body.state).toBe('unsupported');
    expect(view.body.sources).toEqual([]);
  });

  const OTHER_INSTANCE = '00000000-0000-4000-8000-000000000000';
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly send: (h: Awaited<ReturnType<typeof harness>>) => Promise<IResponse>;
  }> = [
    {
      name: 'a replayed sequence',
      send: async (h) => {
        expect((await request(h.handler, h.key)).snapshot().status).toBe(200);
        return await request(h.handler, h.key);
      },
    },
    { name: 'a wrong MAC', send: (h) => request(h.handler, h.key, { mac: 'f'.repeat(64) }) },
    {
      name: 'a request bound to another instance',
      send: (h) => request(h.handler, h.key, { instance: OTHER_INSTANCE }),
    },
    {
      name: 'an unpaired session id',
      send: (h) => request(h.handler, h.key, { sessionId: 'c'.repeat(32) }),
    },
    {
      name: 'an expired session',
      send: (h) => {
        h.clock.advance(900_001);
        return request(h.handler, h.key);
      },
    },
    {
      name: 'a revoked session',
      send: (h) => {
        h.session.revoke();
        return request(h.handler, h.key);
      },
    },
    { name: 'a mutation method', send: (h) => request(h.handler, h.key, { method: 'POST' }) },
    {
      name: 'a browser origin',
      send: (h) => request(h.handler, h.key, { origin: 'https://example.com' }),
    },
    {
      name: 'a rebinding host',
      send: (h) => request(h.handler, h.key, { host: `rebind.example:${TEST_PORT}` }),
    },
    { name: 'a forwarding header', send: (h) => request(h.handler, h.key, { forwarded: true }) },
  ];
  for (const refusal of refusals) {
    it(`refuses ${refusal.name} without reading any source`, async () => {
      const s = source(ready());
      const h = await harness([s]);
      const view = inspect(await refusal.send(h));
      expect(view.status).toBeGreaterThanOrEqual(400);
      expect(view.body).not.toHaveProperty('sources');
      expect(s.calls).toBe(refusal.name === 'a replayed sequence' ? 1 : 0);
    });
  }
});

describe('DiagnosticsPlugin — outbound HTTP source bound', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-outbound-http-sources',
      version: '0.0.0',
      register(ctx) {
        for (let i = 0; i < count; i++) {
          ctx.services.register<IOutboundHttpDiagnosticsSource>(
            CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS,
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
    const { app, started } = boot(MAX_OUTBOUND_HTTP_SOURCES);
    await started;
    await app.stop();
  });

  it('refuses a 17th source with a fixed, value-free configuration error', async () => {
    const { app, started } = boot(MAX_OUTBOUND_HTTP_SOURCES + 1);
    await expect(started).rejects.toThrow(PLUGIN_ERRORS.tooManyOutboundHttpSources);
    await app.stop().catch(() => {});
  });
});

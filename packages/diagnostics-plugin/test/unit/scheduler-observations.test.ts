/**
 * Unit tests for the M98k scheduler-observations protocol: canonical target
 * parsing, the inspector manifest flip, copy-once source reading against
 * hostile sources, the exact wire validator, the connector's `/v1/scheduler`
 * dispatch isolation, the client's negotiated short-circuit, and the
 * plugin's 16-source startup bound.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPlugin, IResponse, ISchedulerDiagnosticsSource } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { PLUGIN_ERRORS } from '../../src/plugin/diagnostics-plugin.ts';
import { currentInspectorsManifest, parseTarget } from '../../src/protocol/protocol.ts';
import {
  buildSchedulerResponse,
  isSchedulerResponseProjection,
  isSchedulerSnapshotProjection,
  MAX_SCHEDULER_SOURCES,
} from '../../src/protocol/scheduler-protocol.ts';
import { createConnectorHandler } from '../../src/transport/connector-handler.ts';
import { ConnectorLimits } from '../../src/transport/limits.ts';
import { QueueObservationMerger } from '../../src/transport/queue-merger.ts';
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

/** A well-formed scheduler record. */
function record(alias = 'tick-alias', operation = 'fire'): Record<string, unknown> {
  return {
    alias,
    operation,
    count: 1,
    lastDurationMs: 2,
    ageMs: 3,
    started: 1,
    succeeded: 1,
    failed: 0,
    contended: 0,
    lockFailed: 0,
    retryAttempts: 0,
    lastLatenessMs: 4,
  };
}

/** A well-formed ready snapshot. */
function ready(alias = 'cron', records = [record()]): Record<string, unknown> {
  return { state: 'ready', alias, coverage: 'owned-instance', records, dropped: 0 };
}

const DISABLED = {
  state: 'disabled',
  alias: null,
  coverage: 'owned-instance',
  records: [],
  dropped: 0,
};

/** A source answering `value` (or throwing it when it is an Error). */
function source(value: unknown): ISchedulerDiagnosticsSource & { calls: number } {
  const s = {
    calls: 0,
    snapshot(): ISchedulerDiagnosticsSource extends { snapshot(): infer T } ? T : never {
      s.calls++;
      if (value instanceof Error) {
        throw value;
      }
      return value as never;
    },
  };
  return s;
}

/** The one-source response's first snapshot. */
function only(value: unknown): unknown {
  const response = buildSchedulerResponse(TEST_INSTANCE_ID, [source(value)]);
  return (response.sources as { snapshot: unknown }[])[0]!.snapshot;
}

function inspect(response: IResponse): {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
} {
  const snapshot = response.snapshot();
  if (snapshot.streaming) {
    throw new Error('unexpected streaming body');
  }
  const text = new TextDecoder().decode(snapshot.body as Uint8Array);
  return {
    status: snapshot.status,
    body: JSON.parse(text) as Record<string, unknown>,
    text,
  };
}

async function harness(schedulerSources: readonly ISchedulerDiagnosticsSource[]) {
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
    schedulerSources,
    eventSources: [],
  });
  session.bindInstance(TEST_INSTANCE_ID);
  return { handler, key, clock, session };
}

/** One `/v1/scheduler` request's overridable parts. */
interface SchedulerRequestParts {
  readonly method?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly instance?: string;
  readonly mac?: string;
}

/** Sends a signed `/v1/scheduler` request; each part may be overridden. */
async function request(
  handler: (request: ReturnType<typeof fakeRequest>) => Promise<IResponse>,
  key: CryptoKey,
  parts: SchedulerRequestParts = {},
): Promise<IResponse> {
  const sequence = parts.sequence ?? 1;
  const instance = parts.instance ?? TEST_INSTANCE_ID;
  const mac = parts.mac ??
    await signRequest(crypto.subtle, key, '/v1/scheduler', sequence, instance);
  return await handler(fakeRequest({
    ...(parts.method !== undefined ? { method: parts.method } : {}),
    url: `http://${HOST}/v1/scheduler`,
    headers: {
      host: HOST,
      'x-setu-session': parts.sessionId ?? TEST_SESSION_ID,
      'x-setu-sequence': String(sequence),
      'x-setu-instance': instance,
      'x-setu-mac': mac,
    },
  }));
}

describe('scheduler protocol — target and manifest', () => {
  it('parses the canonical /v1/scheduler target and nothing else', () => {
    expect(parseTarget('/v1/scheduler', '')).toEqual({
      op: 'scheduler',
      canonicalTarget: '/v1/scheduler',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/scheduler', 'after=0&limit=1')).toBeNull();
    expect(parseTarget('/v1/scheduler/', '')).toBeNull();
  });

  it('activates scheduler in the manifest and leaves the rest reserved', () => {
    const manifest = currentInspectorsManifest();
    expect(manifest.scheduler).toBe(true);
    expect(manifest.health).toBe(true);
    // M98j shipped first on main, so `events` is activated too; the rest
    // stay reserved.
    expect(manifest.events).toBe(true);
    expect(manifest.realtime).toBe(false);
    expect(manifest.storage).toBe(false);
    expect(manifest.outboundHttp).toBe(false);
  });
});

describe('scheduler protocol — source reading', () => {
  it('reads a well-formed snapshot and preserves its fields', () => {
    expect(only(ready())).toEqual(ready());
    expect(only(DISABLED)).toEqual(DISABLED);
  });

  it('answers a fixed value-free snapshot for hostile sources', () => {
    const cases: readonly unknown[] = [
      new Error('canary-throw'),
      'not an object',
      42,
      [],
      { ...ready(), extra: 1 },
      { ...ready(), records: undefined },
      Object.assign(Object.create({ poisoned: true }), ready()),
      // A symbol-keyed extra property is outside the allowlist even though
      // Object.keys never reports it.
      (() => {
        const value = ready() as Record<string, unknown> & Record<symbol, boolean>;
        value[Symbol('extra')] = true;
        return value;
      })(),
      // A getter is never invoked — a snapshot carrying one refuses.
      (() => {
        const value = ready();
        Object.defineProperty(value, 'dropped', { get: () => 1 });
        return value;
      })(),
      { ...ready(), records: Array.from({ length: 65 }, () => record()) },
      // An ARRAY-LIKE object is not an array: the intrinsic-array read
      // refuses it without walking its properties.
      { ...ready(), records: { 0: record(), length: 1 } },
    ];
    for (const value of cases) {
      const snapshot = only(value) as Record<string, unknown>;
      expect(snapshot.state).toBe('collection-failed');
      expect(snapshot.alias).toBeNull();
      expect(snapshot.records).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain('canary');
    }
  });

  it('keeps a throwing source value-free but preserves a failed source’s own alias', () => {
    expect(only(new Error('boom'))).toEqual({
      state: 'collection-failed',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
    expect(only({
      state: 'collection-failed',
      alias: 'cron',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    })).toEqual({
      state: 'collection-failed',
      alias: 'cron',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });
});

describe('scheduler protocol — exact validator', () => {
  it('accepts the well-formed snapshot and response', () => {
    expect(isSchedulerSnapshotProjection(ready())).toBe(true);
    const response = buildSchedulerResponse(TEST_INSTANCE_ID, [source(ready())]);
    expect(isSchedulerResponseProjection(response)).toBe(true);
  });

  const invalidSnapshots: readonly [readonly string[], unknown][] = [
    [['missing dropped'], { ...ready(), dropped: undefined }],
    [['extra key'], { ...ready(), truncated: false }],
    [['bad state'], { ...ready(), state: 'unavailable' }],
    [['bad coverage'], { ...ready(), coverage: 'cluster' }],
    [['disabled with alias'], { ...DISABLED, alias: 'cron' }],
    [['disabled with records'], { ...DISABLED, records: [record()] }],
    [['no-data with records'], { ...ready(), state: 'no-data' }],
    [['ready without records'], { ...ready(), records: [] }],
    [['control alias'], { ...ready(), alias: 'a\u0000b' }],
    [['oversized alias'], { ...ready(), alias: 'x'.repeat(65) }],
    [['record extra key'], { ...ready(), records: [{ ...record(), missed: 1 }] }],
    [['record missing key'], {
      ...ready(),
      records: [(() => {
        const { lockFailed: _omitted, ...rest } = record();
        return rest;
      })()],
    }],
    [['record bad operation'], { ...ready(), records: [record('tick-alias', 'missed')] }],
    [['record negative counter'], { ...ready(), records: [{ ...record(), count: -1 }] }],
    [['record float counter'], { ...ready(), records: [{ ...record(), count: 1.5 }] }],
    [['record bad lateness'], { ...ready(), records: [{ ...record(), lastLatenessMs: -3 }] }],
    [['record bad duration'], { ...ready(), records: [{ ...record(), lastDurationMs: 1.5 }] }],
    [['record control alias'], { ...ready(), records: [record('a\u001bb')] }],
    [['duplicate tuples'], { ...ready(), records: [record(), record()] }],
    [['66 records'], {
      ...ready(),
      records: Array.from({ length: 66 }, (_, i) => record(`job-${i}`)),
    }],
  ];
  for (const [name, value] of invalidSnapshots) {
    it(`refuses ${name.join(' ')}`, () => {
      expect(isSchedulerSnapshotProjection(value)).toBe(false);
    });
  }

  it('refuses a response over the source bound or with duplicate source aliases', () => {
    const many = Array.from(
      { length: MAX_SCHEDULER_SOURCES + 1 },
      (_, i) => source(ready(`cron-${i}`, [])),
    );
    const over = buildSchedulerResponse(TEST_INSTANCE_ID, many);
    expect(isSchedulerResponseProjection(over)).toBe(false);
    const duplicate = buildSchedulerResponse(TEST_INSTANCE_ID, [
      source(ready('same', [record('a')])),
      source(ready('same', [record('b')])),
    ]);
    expect(duplicate).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    });
  });

  it('requires the aggregate state to agree with the per-source states', () => {
    const wrong = buildSchedulerResponse(TEST_INSTANCE_ID, [source(ready())]);
    (wrong as { state: string }).state = 'no-data';
    expect(isSchedulerResponseProjection(wrong)).toBe(false);
  });

  it('accepts a collapsed collection-failed response with no sources', () => {
    expect(isSchedulerResponseProjection({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'collection-failed',
      sources: [],
    })).toBe(true);
  });
});

describe('connector — GET /v1/scheduler', () => {
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

  it('refuses a mutation method structurally', async () => {
    const s = source(ready());
    const { handler, key } = await harness([s]);
    const view = inspect(await request(handler, key, { method: 'POST' }));
    expect(view.status).toBe(400);
    expect(s.calls).toBe(0);
  });

  it('keeps a throwing source value-free on the wire', async () => {
    const { handler, key } = await harness([
      source(new Error('canary-throw-SYNTHETIC')),
    ]);
    const view = inspect(await request(handler, key));
    expect(view.status).toBe(200);
    expect(view.body.state).toBe('collection-failed');
    expect(view.text).not.toContain('canary-throw-SYNTHETIC');
  });
});

describe('DiagnosticsClient — scheduler()', () => {
  it('answers a local unsupported response when the manifest lacks the inspector', async () => {
    const clock = new MutableClock();
    const session = await createTestSession(crypto.subtle, clock, 900_000);
    const key = await importTestKey(crypto.subtle);
    await session.bindInstance; // no-op read to keep linters honest
    const legacyBody = JSON.stringify({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 900_000,
    });
    const bodyBytes = new TextEncoder().encode(legacyBody);
    const digest = await crypto.subtle.digest('SHA-256', bodyBytes);
    const bodyHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    const responseFields = [
      'setu-diagnostics-v1',
      'response',
      TEST_SESSION_ID,
      TEST_INSTANCE_ID,
      '1',
      '/v1/status',
      '200',
      bodyHex,
    ].join('\n');
    const macBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(responseFields),
    );
    const mac = [...new Uint8Array(macBytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
    let requests = 0;
    const fetchFn = ((input: URL | RequestInfo): Promise<Response> => {
      requests++;
      const url = String(input);
      if (url.endsWith('/v1/status')) {
        return Promise.resolve(
          new Response(bodyBytes, {
            status: 200,
            headers: { 'x-setu-instance': TEST_INSTANCE_ID, 'x-setu-mac': mac },
          }),
        );
      }
      return Promise.reject(new Error('must not send an addon request'));
    }) as unknown as typeof fetch;
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${TEST_PORT}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch: fetchFn,
      timing: { setTimeout, clearTimeout },
    });
    const response = await client.scheduler();
    client.close();
    expect(requests).toBe(1);
    expect(response).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'unsupported',
      sources: [],
    });
    await session.revoke();
  });
});

describe('DiagnosticsPlugin — scheduler source bound', () => {
  function sources(count: number): IPlugin {
    return {
      name: 'fake-scheduler-sources',
      version: '0.0.0',
      register(ctx) {
        for (let i = 0; i < count; i++) {
          ctx.services.register<ISchedulerDiagnosticsSource>(
            CAPABILITIES.SCHEDULER_DIAGNOSTICS,
            createSchedulerDisabledSource(),
            { multi: true },
          );
        }
      },
    };
  }

  function createSchedulerDisabledSource(): ISchedulerDiagnosticsSource {
    return { snapshot: () => DISABLED as never };
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
    return app.start().then(() => app);
  }

  it(`boots with exactly the ${MAX_SCHEDULER_SOURCES}-source bound`, async () => {
    const app = await boot(MAX_SCHEDULER_SOURCES);
    await app.stop();
  });

  it(`refuses startup above ${MAX_SCHEDULER_SOURCES} scheduler sources`, async () => {
    await expect(boot(MAX_SCHEDULER_SOURCES + 1)).rejects.toThrow(
      PLUGIN_ERRORS.tooManySchedulerSources,
    );
  });
});

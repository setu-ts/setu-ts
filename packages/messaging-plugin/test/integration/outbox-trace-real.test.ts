/**
 * Outbox trace re-parenting against REAL OpenTelemetry (M107 §3.9).
 *
 * The real API, SDK and `AsyncLocalStorageContextManager`, the tracer host
 * built by the REAL `buildTracerHost` (in-memory exporter), and the REAL
 * `TelemetryPlugin` with its request middleware — so the server span, the
 * write's captured `traceparent`, the relay span, `TracedBroker`'s producer
 * span and the consumer span are all produced by shipped code.
 *
 * - A request writes a row; a sweep run later from a CLEAN context publishes
 *   it. request → relay → publish → receive is ONE trace, asserted by exact
 *   parent ids — the stored `traceparent` is the only link between the
 *   request and the sweep.
 * - A traceless row, and a row whose stored `traceparent` was edited into an
 *   invalid value, swept by `dispatch()` from INSIDE a request, each start
 *   their own ROOT relay span rather than parenting to that request (D16).
 * - The control: the same sweep through a telemetry service that drops
 *   `root` parents the traceless row to the surrounding span — so the D16
 *   assertion discriminates.
 *
 * Spans are read BEFORE `app.stop()`: the plugin's `onClose` shuts the
 * provider down, which resets the in-memory exporter. And `exporter` is set:
 * without it the plugin registers its noop service and every id is empty.
 * Guarded with `ignore:` when the optional OTel packages are not resolvable.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, ISpan, ITelemetryService, SpanOptions } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { TelemetryPlugin } from '../../../telemetry-plugin/src/plugin/telemetry-plugin.ts';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { buildTracerHost, setOtelApi } from '../../../telemetry-plugin/src/tracing/tracer.ts';
import { loadAsyncLocalStorageContextManager } from '../../../telemetry-plugin/src/tracing/context-manager.ts';
import type { TracerHost } from '../../../telemetry-plugin/src/interfaces/index.ts';

import { MessagingPlugin } from '../../src/index.ts';
import type { IOutbox } from '../../src/index.ts';
import { edit, orderPlaced, outboxHarness } from '../fixtures/outbox.ts';

/** A finished span reduced to what the parent-chain assertions need. */
interface FinishedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
}

interface RealOtel {
  readonly host: TracerHost;
  readonly finished: () => Promise<readonly FinishedSpan[]>;
}

/** The optional OTel modules, loaded once; `null` when not resolvable. */
async function loadOtel(): Promise<
  {
    readonly sdk: typeof import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
    readonly resources: typeof import('npm:@opentelemetry/resources@^2.9.0');
  } | null
> {
  try {
    const api = await import('npm:@opentelemetry/api@^1.9.0');
    const sdk = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
    const resources = await import('npm:@opentelemetry/resources@^2.9.0');
    const manager = await loadAsyncLocalStorageContextManager();
    api.context.setGlobalContextManager(manager as never);
    setOtelApi(api as never);
    return { sdk, resources };
  } catch {
    return null;
  }
}

const modules = await loadOtel();

/**
 * A FRESH host through the REAL `buildTracerHost`, exporting into memory — one
 * per test, because stopping an app shuts its provider down for good.
 */
function realOtel(): RealOtel {
  const { sdk, resources } = modules!;
  const exporter = new sdk.InMemorySpanExporter();
  const host = buildTracerHost({
    sdkMod: sdk as never,
    resourcesMod: resources as never,
    pluginOptions: { serviceName: 'm107-outbox-trace', exporter: 'console' },
    // The console-exporter seam, handed the in-memory exporter.
    consoleExporterCtor: (class {
      constructor() {
        return exporter;
      }
    }) as never,
    validated: true,
    contextActivation: true,
  });
  return {
    host,
    finished: async () => {
      await host.forceFlush();
      return exporter.getFinishedSpans().map((span) => {
        const raw = span as unknown as {
          parentSpanContext?: { spanId?: string };
          parentSpanId?: string;
        };
        return {
          name: span.name,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: raw.parentSpanContext?.spanId ?? raw.parentSpanId,
        };
      });
    },
  };
}

const RELAY = `outbox relay ${orderPlaced.topic}`;
const PUBLISH = `publish ${orderPlaced.topic}`;
const RECEIVE = `receive ${orderPlaced.topic}`;

/** A real app: runtime, memory database, telemetry (middleware on), messaging + outbox. */
function buildApp(otel: RealOtel, background?: (promise: Promise<unknown>) => void) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({ type: 'memory' }),
      TelemetryPlugin({
        serviceName: 'm107-outbox-trace',
        exporter: 'console',
        tracerProviderFactory: () => Promise.resolve(otel.host),
      }),
      MessagingPlugin({
        outbox: {
          store: createDatabaseOutboxStore(),
          relay: { schedule: false },
          ...(background !== undefined ? { background } : {}),
        },
      }),
    ],
  });
}

describe('outbox trace re-parenting (real OpenTelemetry)', { ignore: modules === null }, () => {
  it('request → relay → publish → receive is ONE trace when the sweep runs from a clean context', async () => {
    const otel = realOtel();
    const app = buildApp(otel);
    await app.start();
    try {
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)
        .subscribe(orderPlaced.topic, () => {});
      app.router.post('/orders', async (ctx) => {
        await db.transaction((uow) => outbox.write(uow, orderPlaced, { key: 'K', n: 1 }));
        return ctx.response.status(201).json({ ok: true });
      });

      expect((await app.inject({ method: 'POST', url: 'http://localhost/orders' })).statusCode)
        .toBe(201);
      // The sweep runs OUTSIDE the request: no span is active here.
      expect((await outbox.sweep()).published).toBe(1);

      const spans = await otel.finished();
      const byName = new Map(spans.map((s) => [s.name, s]));
      const server = byName.get('POST /orders');
      const relay = byName.get(RELAY);
      const producer = byName.get(PUBLISH);
      const consumer = byName.get(RECEIVE);
      expect(server).toBeDefined();
      expect(relay).toBeDefined();
      expect(producer).toBeDefined();
      expect(consumer).toBeDefined();

      expect(new Set([server, relay, producer, consumer].map((s) => s!.traceId)).size).toBe(1);
      expect(server!.parentSpanId).toBeUndefined();
      expect(relay!.parentSpanId).toBe(server!.spanId);
      expect(producer!.parentSpanId).toBe(relay!.spanId);
      expect(consumer!.parentSpanId).toBe(producer!.spanId);
    } finally {
      await app.stop();
    }
  });

  it('a traceless row and an edited-traceparent row, dispatched inside a request, get ROOT relay spans', async () => {
    const otel = realOtel();
    const sweeps: Promise<unknown>[] = [];
    const app = buildApp(otel, (promise) => sweeps.push(promise));
    await app.start();
    try {
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      const telemetry = app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
      await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)
        .subscribe(orderPlaced.topic, () => {});
      // Written with no span active: no traceparent stored.
      const traceless = await db.transaction((uow) => outbox.write(uow, orderPlaced, { n: 1 }));
      // Written inside a span, then its traceparent edited into an invalid value.
      const edited = await telemetry.withSpan(
        'writer',
        () => db.transaction((uow) => outbox.write(uow, orderPlaced, { n: 2 })),
      );
      await edit(db, edited, { traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01` });
      app.router.post('/kick', (ctx) => {
        outbox.dispatch();
        return ctx.response.status(202).json({ ok: true });
      });

      expect((await app.inject({ method: 'POST', url: 'http://localhost/kick' })).statusCode)
        .toBe(202);
      expect(sweeps.length).toBe(1);
      await sweeps[0];

      const spans = await otel.finished();
      const request = spans.find((s) => s.name === 'POST /kick');
      const relays = spans.filter((s) => s.name === RELAY);
      expect(request).toBeDefined();
      expect(relays.length).toBe(2);
      for (const relay of relays) {
        expect(relay.parentSpanId).toBeUndefined();
        expect(relay.traceId).not.toBe(request!.traceId);
      }
      // Two separate roots, and each producer span is a child of its own relay.
      expect(new Set(relays.map((r) => r.traceId)).size).toBe(2);
      const producers = spans.filter((s) => s.name === PUBLISH);
      expect(producers.map((p) => p.parentSpanId).sort()).toEqual(
        relays.map((r) => r.spanId).sort(),
      );
      expect(traceless).not.toBe(edited);
    } finally {
      await app.stop();
    }
  });

  it('control: a telemetry service dropping `root` parents a traceless row to the surrounding span', async () => {
    const otel = realOtel();
    const real = new TelemetryService(otel.host);
    /** Forwards everything except `root` — an implementation that ignores it. */
    const droppingRoot: ITelemetryService = {
      withSpan<T>(name: string, fn: (span: ISpan) => Promise<T>, options?: SpanOptions) {
        const forwarded = Object.fromEntries(
          Object.entries(options ?? {}).filter(([key]) => key !== 'root'),
        ) as SpanOptions;
        return real.withSpan(name, fn, forwarded);
      },
      activeSpanContext: () => real.activeSpanContext(),
    };

    for (const [label, telemetry] of [['honoured', real], ['dropped', droppingRoot]] as const) {
      const h = await outboxHarness({ telemetry });
      await h.write({ n: 1 });
      await real.withSpan(`request (${label})`, () => h.sweep());
    }

    const spans = await otel.finished();
    const request = (label: string) => spans.find((s) => s.name === `request (${label})`)!;
    const relays = spans.filter((s) => s.name === RELAY);
    expect(relays.length).toBe(2);
    const [honoured, dropped] = relays;
    // `root` honoured: no parent. `root` dropped: the request becomes the parent.
    expect(honoured!.parentSpanId).toBeUndefined();
    expect(dropped!.parentSpanId).toBe(request('dropped').spanId);
    expect(dropped!.traceId).toBe(request('dropped').traceId);
  });
});

// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * X34-1 / X29-3 end to end, against REAL OpenTelemetry.
 *
 * X34 measured a single request fanning out to a broker and a queue: the broker
 * hop joined the request trace across a process boundary while
 * `x34.queue.handle` was orphaned with `parent=-`. That run was its own control
 * — the same request, the same collector, one link present and one absent.
 *
 * No fake can settle this. A recording double would report a `traceparent`
 * written and read while the spans still landed in separate traces, which is
 * exactly the state M75's review found its own in-repo test could not
 * discriminate ("`toBeDefined()`, so a span parented into the wrong trace
 * satisfied it"). So this asserts on the finished spans' trace identity and
 * parent chain, by MATCHING IDS.
 *
 * Guarded: skipped when the optional OTel packages cannot be resolved.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IJob, TelemetryContext } from '@setu-ts/common';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { setOtelApi } from '../../../telemetry-plugin/src/tracing/tracer.ts';
import { loadAsyncLocalStorageContextManager } from '../../../telemetry-plugin/src/tracing/context-manager.ts';
import type { TracerHost } from '../../../telemetry-plugin/src/interfaces/index.ts';
import { TracedQueue } from '../../src/tracing/traced-queue.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/** A finished span, reduced to what the parent-chain assertions need. */
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

/**
 * Wires the real OTel API + SDK, exporting into memory.
 *
 * `activeSpanContext` is supplied the same way `buildTracerHost` supplies it —
 * over `api.trace.getActiveSpan()` — so the log-join half is exercised against
 * the real context manager rather than a stand-in.
 *
 * @returns The host and a span reader, or `null` when the packages are absent
 */
async function realOtel(): Promise<RealOtel | null> {
  let api: typeof import('npm:@opentelemetry/api@^1.9.0');
  let sdk: typeof import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
  try {
    api = await import('npm:@opentelemetry/api@^1.9.0');
    sdk = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
    const manager = await loadAsyncLocalStorageContextManager();
    api.context.setGlobalContextManager(manager as never);
  } catch {
    return null;
  }

  setOtelApi(api as never);
  const exporter = new sdk.InMemorySpanExporter();
  const provider = new sdk.BasicTracerProvider(
    { spanProcessors: [new sdk.SimpleSpanProcessor(exporter)] } as never,
  );
  const tracer = provider.getTracer('m90i-queue-continuity');

  const host: TracerHost = {
    startSpan(
      name: string,
      options?: {
        kind?: number;
        attributes?: Record<string, unknown>;
        parentContext?: TelemetryContext;
      },
    ) {
      const otelOptions: Record<string, unknown> = {};
      if (options?.kind !== undefined) otelOptions.kind = options.kind;
      if (options?.attributes) otelOptions.attributes = options.attributes;
      let parent: unknown;
      const pc = options?.parentContext;
      if (pc?.traceId && pc?.spanId) {
        parent = api.trace.setSpan(
          api.context.active(),
          api.trace.wrapSpanContext({
            traceId: pc.traceId,
            spanId: pc.spanId,
            traceFlags: parseInt(pc.traceFlags ?? '01', 16),
            isRemote: true,
          }),
        );
      }
      return tracer.startSpan(name, otelOptions, parent as never);
    },
    activate<T>(span: unknown, fn: () => Promise<T>): Promise<T> {
      return api.context.with(api.trace.setSpan(api.context.active(), span as never), fn);
    },
    extractContext: () => ({ _opaque: Symbol.for('he.telemetry.context') } as TelemetryContext),
    injectContext: () => ({}),
    shutdown: () => provider.shutdown(),
    forceFlush: () => provider.forceFlush(),
  };

  return {
    host,
    finished: async () => {
      await provider.forceFlush();
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

const otel = await realOtel();

describe('real-OTel trace continuity across the queue hop', () => {
  it('keeps an HTTP-span → enqueue → process chain inside ONE trace', async () => {
    if (!otel) {
      console.warn('skipped: optional OpenTelemetry packages are not resolvable');
      return;
    }
    const telemetry = new TelemetryService(otel.host);
    const runtime = new FakeRuntimeServices();
    const adapter = new MemoryQueue();
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 5 });
    const queue = new TracedQueue(service, telemetry);
    await service.connect();

    let delivered: IJob<{ id: string }> | undefined;
    const done = Promise.withResolvers<void>();
    queue.process<{ id: string }>('order.export', (job) => {
      delivered = job;
      done.resolve();
    });

    // The shape every application has: a request span that enqueues.
    let requestTraceId = '';
    let requestSpanId = '';
    await telemetry.withSpan('POST /orders', async (span) => {
      requestTraceId = span.spanContext().traceId;
      requestSpanId = span.spanContext().spanId;
      await queue.add('order.export', { id: 'o-1' });
    });

    // The fixture's timers are manually advanced, so the poll loop is driven
    // here rather than raced against wall-clock time (the repo's never-mix-
    // clocks rule).
    await runtime.advanceMs(50);
    await done.promise;
    const spans = await otel.finished();
    await service.disconnect();

    const request = spans.find((s) => s.name === 'POST /orders');
    const enqueue = spans.find((s) => s.name === 'enqueue order.export');
    const process = spans.find((s) => s.name === 'process order.export');

    // Vacuity guard: `undefined === undefined` would satisfy every identity
    // assertion below, so the spans must exist before they are compared.
    expect(request).toBeDefined();
    expect(enqueue).toBeDefined();
    expect(process).toBeDefined();

    // ONE trace, matched by id — not merely "a trace id is present".
    expect(enqueue?.traceId).toBe(requestTraceId);
    expect(process?.traceId).toBe(requestTraceId);

    // …and an unbroken parent chain through it.
    expect(enqueue?.parentSpanId).toBe(requestSpanId);
    expect(process?.parentSpanId).toBe(enqueue?.spanId);

    // The join travels on the header, which is what makes it work across a
    // process boundary rather than through ambient context.
    expect(delivered?.headers?.traceparent)
      .toBe(`00-${requestTraceId}-${enqueue?.spanId}-01`);
  });

  it('starts an honest ROOT for a job that carries no traceparent', async () => {
    if (!otel) {
      console.warn('skipped: optional OpenTelemetry packages are not resolvable');
      return;
    }
    const telemetry = new TelemetryService(otel.host);
    const runtime = new FakeRuntimeServices();
    const adapter = new MemoryQueue();
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 5 });
    const queue = new TracedQueue(service, telemetry);
    await service.connect();

    const done = Promise.withResolvers<void>();
    queue.process('legacy.job', () => done.resolve());

    // Enqueued straight on the SERVICE, bypassing the decorator — a job written
    // before this channel existed, or by a non-framework producer.
    await service.add('legacy.job', { id: 'o-2' });

    await runtime.advanceMs(50);
    await done.promise;
    const spans = await otel.finished();
    await service.disconnect();

    const processed = spans.find((s) => s.name === 'process legacy.job');
    expect(processed).toBeDefined();
    // A root, not a failure: untraced work still has to run.
    expect(processed?.parentSpanId).toBeUndefined();
  });
});

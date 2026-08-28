// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * End-to-end trace continuity against REAL OpenTelemetry.
 *
 * This is the milestone's thesis, and no fake can settle it. `M75` closed two
 * independent breaks: the broker carried no `traceparent`, and
 * `TelemetryService.withSpan` never made its span the active OTel context.
 * Fixing only the broker half yields a correctly-linked producer→consumer pair
 * floating in its OWN trace, disconnected from the request that caused it — and
 * every fake-backed assertion in this package passes in exactly that state.
 *
 * So this suite runs the real API, the real SDK, the real
 * `AsyncLocalStorageContextManager` and the real brokers, and asserts on the
 * finished spans' trace identity and parent chain.
 *
 * Guarded: skipped when the optional OTel packages cannot be resolved.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SpanOptions, TelemetryContext } from '@setu-ts/common';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { setOtelApi } from '../../../telemetry-plugin/src/tracing/tracer.ts';
import { loadAsyncLocalStorageContextManager } from '../../../telemetry-plugin/src/tracing/context-manager.ts';
import type { TracerHost } from '../../../telemetry-plugin/src/interfaces/index.ts';
import { TracedBroker } from '../../src/tracing/traced-broker.ts';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

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
 * Wires the real OTel API + SDK the way `buildTracerHost` does, exporting into
 * memory. Returns `null` when the optional packages are absent.
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
  const tracer = provider.getTracer('m75-continuity');

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

describe('real-OTel trace continuity across the broker', () => {
  it('keeps an HTTP-span → publish → receive chain inside ONE trace', async () => {
    if (!otel) {
      console.warn('skipped: optional OpenTelemetry packages are not resolvable');
      return;
    }
    const telemetry = new TelemetryService(otel.host);
    const inner = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    const broker = new TracedBroker(inner, telemetry, 'memory');
    await broker.connect();
    await broker.subscribe('order.created', () => {});

    // Stand in for the request-span middleware, then publish from "inside the
    // handler" — the shape every application has.
    await telemetry.withSpan('POST /orders', async () => {
      await broker.publish('order.created', { id: 'o1' });
    }, { kind: 'server' } as SpanOptions);

    const spans = await otel.finished();
    const byName = new Map(spans.map((s) => [s.name, s]));
    const server = byName.get('POST /orders');
    const producer = byName.get('publish order.created');
    const consumer = byName.get('receive order.created');

    expect(server).toBeDefined();
    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();

    // ONE trace. With activation removed this is 2 — the server span is
    // orphaned from the pair — and with the traceparent removed it is 2 the
    // other way, the consumer orphaned from the producer.
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);

    // And the chain, not merely the trace: server → producer → consumer.
    expect(server?.parentSpanId).toBeUndefined();
    expect(producer?.parentSpanId).toBe(server?.spanId);
    expect(consumer?.parentSpanId).toBe(producer?.spanId);

    await broker.disconnect();
  });

  it('carries the trace across a process boundary on the traceparent alone', async () => {
    if (!otel) {
      console.warn('skipped: optional OpenTelemetry packages are not resolvable');
      return;
    }
    // The case above cannot prove the header is load-bearing: in-memory
    // delivery runs INSIDE the producer's active context, so the consumer
    // inherits the trace ambiently even with no `traceparent` at all (verified
    // by writing the header under a wrong name — that case still passed).
    //
    // A real broker hop carries the headers and NOT the call stack. This models
    // exactly that: capture what the producer put on the wire, then deliver it
    // into a second broker from a clean context.
    const telemetry = new TelemetryService(otel.host);

    let onWire: Readonly<Record<string, string>> = {};
    // A plain recording adapter, NOT `Object.create(realBroker)`: prototype
    // cloning cannot reach a class's private fields, so `connect()` throws.
    const recordingInner = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      reachability: () => Promise.resolve(true),
      isHealthy: () => Promise.resolve(true),
      publish: () => Promise.resolve(),
      publishWithHeaders: (
        _topic: string,
        _message: unknown,
        headers: Readonly<Record<string, string>>,
      ) => {
        onWire = headers;
        return Promise.resolve();
      },
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(undefined),
      requestWithHeaders: () => Promise.resolve(undefined),
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    } as unknown as MessageBrokerAdapter;
    const producer = new TracedBroker(recordingInner, telemetry, 'memory');
    await producer.connect();

    const before = (await otel.finished()).length;
    await telemetry.withSpan('POST /orders', async () => {
      await producer.publish('order.shipped', { id: 'o2' });
    }, { kind: 'server' } as SpanOptions);

    // A separate "consumer process": a second broker, delivered from a clean
    // context with no active span anywhere.
    const consumerInner = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    const consumer = new TracedBroker(consumerInner, telemetry, 'memory');
    await consumer.connect();
    await consumer.subscribe('order.shipped', () => {});
    await consumerInner.publishWithHeaders('order.shipped', { id: 'o2' }, onWire);

    const spans = (await otel.finished()).slice(before);
    const byName = new Map(spans.map((sp) => [sp.name, sp]));
    const server = byName.get('POST /orders');
    const producerSpan = byName.get('publish order.shipped');
    const consumerSpan = byName.get('receive order.shipped');

    expect(server).toBeDefined();
    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();

    // The header is the ONLY link here, so this fails the moment the producer
    // stops writing `traceparent` or the consumer stops reading it.
    expect(consumerSpan?.traceId).toBe(producerSpan?.traceId);
    expect(consumerSpan?.parentSpanId).toBe(producerSpan?.spanId);
    expect(producerSpan?.traceId).toBe(server?.traceId);

    await producer.disconnect();
    await consumer.disconnect();
  });
});

/**
 * Real-import integration test for the OTLP exporter path: exercises the real
 * import of the installed OTel packages and verifies a full round-trip span.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

describe('OTel real-import integration', () => {
  it('should load OTLP exporter and build a real span', async () => {
    // Not swallowed: a real failure inside must fail the test.
    // Lazy-load the OTel packages
    const sdkMod = await import('@opentelemetry/sdk-trace-base');
    const resourcesMod = await import('@opentelemetry/resources');

    const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = sdkMod;
    const { resourceFromAttributes } = resourcesMod;

    // Create an in-memory exporter (no network, no console noise)
    const exporter = new InMemorySpanExporter();
    const resource = resourceFromAttributes({ 'service.name': 'test-service' });
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const tracer = provider.getTracer('test', '1.0.0');
    const span = tracer.startSpan('real-integration-span');
    span.setAttribute('http.method', 'GET');
    span.setAttribute('http.status_code', 200);
    span.end();

    // Force flush and verify
    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();

    expect(finished).toHaveLength(1);
    expect(finished[0]!.name).toBe('real-integration-span');

    // In OTel SDK 2.x, span attributes are a plain object, NOT a Map — the
    // old `attrs.get(...)` form threw a TypeError that the swallowed catch
    // hid (the test passed without ever asserting). Access as a record.
    // deno-lint-ignore no-explicit-any
    const attrs = finished[0]!.attributes as Record<string, any>;
    expect(attrs['http.method']).toBe('GET');
    expect(attrs['http.status_code']).toBe(200);

    // Cleanup
    await provider.shutdown();
  });

  it('should load OTLP trace exporter constructor', async () => {
    const mod = await import('@opentelemetry/exporter-trace-otlp-http');
    expect(mod.OTLPTraceExporter).toBeDefined();
    expect(typeof mod.OTLPTraceExporter).toBe('function');
  });

  // N1 guarded real-import test: assert real OTel parenting.
  // When a parent traceparent is provided, the exported span's traceId
  // and parentSpanContext must match the incoming parent context.
  //
  // NOTE: In OTel SDK 2.x, `spanContext().parentSpanId` does NOT exist
  // (SpanContext is W3C-only: traceId, spanId, traceFlags, isRemote).
  // The parent span ID lives on `parentSpanContext?.spanId` of the
  // ReadableSpan, not on spanContext().
  it('should parent real OTel span to incoming traceparent context', async () => {
    const sdkMod = await import('@opentelemetry/sdk-trace-base');
    const resourcesMod = await import('@opentelemetry/resources');
    const apiMod = await import('@opentelemetry/api');

    const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = sdkMod;
    const { resourceFromAttributes } = resourcesMod;
    const { trace, context } = apiMod;

    const exporter = new InMemorySpanExporter();
    const resource = resourceFromAttributes({ 'service.name': 'test-service' });
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    // Register globally so the SDK's context propagation works correctly.
    trace.setGlobalTracerProvider(provider);

    const tracer = provider.getTracer('test', '1.0.0');

    // Simulate an incoming W3C traceparent: traceId=abc123, parentSpanId=def456
    // traceId must be exactly 32 hex chars, spanId must be exactly 16 hex chars (W3C spec).
    const incomingTraceId = 'abc123def456789012345678901234ab';
    const incomingParentSpanId = 'def4567890123456';
    const traceFlags = 1;

    // Build an OTel parent span context from the incoming traceparent.
    const parentSpanContext = trace.wrapSpanContext({
      traceId: incomingTraceId,
      spanId: incomingParentSpanId,
      traceFlags,
      isRemote: true,
    });
    const parentContext = trace.setSpan(context.active(), parentSpanContext);

    // Start a server span WITH the parent context as the 3rd argument.
    // This is the exact pattern used by buildTracerHost.startSpan.
    const serverSpan = tracer.startSpan(
      'GET /test-parenting',
      { kind: 1 /* SpanKind.SERVER */ },
      parentContext,
    );
    serverSpan.setAttribute('http.method', 'GET');
    serverSpan.setAttribute('http.status_code', 200);
    serverSpan.end();

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();

    expect(finished).toHaveLength(1);
    // In SDK 2.x, attributes are a plain object, not a Map.
    // deno-lint-ignore no-explicit-any
    const spanAttrs = finished[0]!.attributes as Record<string, any>;
    expect(spanAttrs['http.method']).toBe('GET');
    expect(spanAttrs['http.status_code']).toBe(200);

    // N1 assertion: the exported span MUST have:
    // 1. traceId matching the incoming traceId (trace inheritance)
    // 2. parentSpanContext.spanId matching the incoming parentSpanId (parenting)
    //
    // In OTel SDK 2.x, spanContext() does NOT include parentSpanId
    // (SpanContext is W3C-only: traceId, spanId, traceFlags, isRemote).
    // The parent info lives on `parentSpanContext?.spanId` of the ReadableSpan.
    const exportedSpan = finished[0]!;
    const exportedSpanContext = exportedSpan.spanContext();
    expect(exportedSpanContext.traceId).toBe(incomingTraceId);

    // deno-lint-ignore no-explicit-any
    const parentCtx = (exportedSpan as any).parentSpanContext as
      | {
          traceId: string;
          spanId: string;
        }
      | undefined;
    expect(parentCtx).toBeDefined();
    expect(parentCtx?.traceId).toBe(incomingTraceId);
    expect(parentCtx?.spanId).toBe(incomingParentSpanId);

    await provider.shutdown();
  });
});

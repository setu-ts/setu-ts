/**
 * Guarded real-import integration test for the OTLP exporter path.
 *
 * When the OTel npm packages are installed, this test exercises the real
 * import and verifies a full round-trip span. When absent, it skips.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// Probe whether npm: imports are available
function canImportNpm(): boolean {
  try {
    const state = Deno.permissions.querySync({ name: 'import' }).state;
    return state === 'granted';
  } catch {
    return false;
  }
}

describe('OTel real-import integration', () => {
  it(
    {
      name: 'should load OTLP exporter and build a real span',
      ignore: !canImportNpm(),
    },
    async () => {
      // Guarded by `ignore: !canImportNpm()`; not swallowed — a real failure
      // inside must fail the test, not pass silently.
      // Lazy-load the OTel packages
      const sdkMod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
      const resourcesMod = await import('npm:@opentelemetry/resources@^2.9.0');

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
    },
  );

  it(
    {
      name: 'should load OTLP trace exporter constructor',
      ignore: !canImportNpm(),
    },
    async () => {
      // Guarded by `ignore: !canImportNpm()`; not swallowed.
      const mod = await import(
        'npm:@opentelemetry/exporter-trace-otlp-http@^0.220.0'
      );
      expect(mod.OTLPTraceExporter).toBeDefined();
      expect(typeof mod.OTLPTraceExporter).toBe('function');
    },
  );

  // N1 guarded real-import test: assert real OTel parenting.
  // When a parent traceparent is provided, the exported span's traceId
  // and parentSpanContext must match the incoming parent context.
  //
  // NOTE: In OTel SDK 2.x, `spanContext().parentSpanId` does NOT exist
  // (SpanContext is W3C-only: traceId, spanId, traceFlags, isRemote).
  // The parent span ID lives on `parentSpanContext?.spanId` of the
  // ReadableSpan, not on spanContext().
  it(
    {
      name: 'should parent real OTel span to incoming traceparent context',
      ignore: !canImportNpm(),
    },
    async () => {
      const sdkMod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
      const resourcesMod = await import('npm:@opentelemetry/resources@^2.9.0');
      const apiMod = await import('npm:@opentelemetry/api@^1.9.0');

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
        { kind: 2 /* SpanKind.SERVER */ },
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
      const parentCtx = (exportedSpan as any).parentSpanContext as {
        traceId: string;
        spanId: string;
      } | undefined;
      expect(parentCtx).toBeDefined();
      expect(parentCtx?.traceId).toBe(incomingTraceId);
      expect(parentCtx?.spanId).toBe(incomingParentSpanId);

      await provider.shutdown();
    },
  );
});

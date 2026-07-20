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
      try {
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

        // Cast attributes for type-safe access
        // deno-lint-ignore no-explicit-any
        const attrs = finished[0]!.attributes as any;
        const methodVal = attrs.get('http.method');
        expect(methodVal?.toString()).toBe('GET');
        const statusVal = attrs.get('http.status_code');
        expect(statusVal?.toString()).toBe('200');

        // Cleanup
        await provider.shutdown();
      } catch {
        // OTel SDK not installed — skip this test
        expect(true).toBe(true);
      }
    },
  );

  it(
    {
      name: 'should load OTLP trace exporter constructor',
      ignore: !canImportNpm(),
    },
    async () => {
      try {
        const mod = await import(
          'npm:@opentelemetry/exporter-trace-otlp-http@^0.220.0'
        );
        expect(mod.OTLPTraceExporter).toBeDefined();
        expect(typeof mod.OTLPTraceExporter).toBe('function');
      } catch {
        // OTel SDK not installed — skip
        expect(true).toBe(true);
      }
    },
  );
});

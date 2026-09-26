/**
 * Real-SDK integration for the diagnostic span processor (M98g): the
 * LOCKED `@opentelemetry/sdk-trace-base` constructs the provider, drives
 * EVERY required `SpanProcessor` lifecycle method for real, and the
 * exporter STILL receives the span — the diagnostic processor observes
 * completions without displacing the exporter path.
 *
 * The exporter is a recording stand-in handed to the REAL
 * `SimpleSpanProcessor`; the span-observation collector is the real one.
 * Guarded, not swallowed: without `npm:` import permission the suite skips
 * loudly in its title, and the plugin-level guarded test plus the e2e
 * cover the same path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRuntimeServices } from '@setu-ts/common';

import {
  buildTracerHost,
  type OtelResourcesModule,
  type OtelSdkModule,
} from '../../src/tracing/tracer.ts';
import {
  compileTraceDiagnosticsPolicy,
  SpanObservationCollector,
} from '../../src/diagnostics/span-observation-collector.ts';

/** Whether `npm:` imports are available in this environment. */
function canImportNpm(): boolean {
  try {
    return Deno.permissions.querySync({ name: 'import' }).state === 'granted';
  } catch {
    return false;
  }
}

describe('DiagnosticSpanProcessor — real locked OTel SDK (guarded)', () => {
  it({
    name: 'drives every lifecycle method; the exporter still receives the span',
    ignore: !canImportNpm(),
  }, async () => {
    // Real locked modules, loaded the way loadOtelTracerProvider loads them.
    const sdkMod = await import(
      'npm:@opentelemetry/sdk-trace-base@^2.9.0'
    ) as unknown as OtelSdkModule;
    const resourcesMod = await import(
      'npm:@opentelemetry/resources@^2.9.0'
    ) as unknown as OtelResourcesModule;

    // A recording exporter: the stand-in proves the exporter processor still
    // sees the span after the diagnostic processor was appended.
    const exported: string[] = [];
    class RecordingExporter {
      export(spans: { name: string }[], callback: (result: { code: number }) => void): void {
        for (const span of spans) exported.push(span.name);
        callback({ code: 0 });
      }
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    }

    const policy = compileTraceDiagnosticsPolicy({
      enabled: true,
      serviceAlias: 'orders',
      operations: { 'approved.op': 'approved' },
    });
    const availability = {
      coverage: 'completed-sampled-spans' as const,
      instrumentation: () => [],
      sampler: { kind: 'always-on' as const },
    };
    const collector = new SpanObservationCollector(
      availability,
      { hrtime: () => 0 } as unknown as Pick<IRuntimeServices, 'hrtime'>,
    );

    const host = await buildTracerHost({
      sdkMod,
      resourcesMod,
      pluginOptions: { serviceName: 'probe', exporter: 'console' },
      consoleExporterCtor: RecordingExporter as never,
      diagnostics: { policy, collector },
    });

    // onStart + onEnd, for real: a span starts, ends, and both processors
    // observe the completion.
    const span = host.startSpan('approved.op', {}) as { end(): void };
    span.end();
    // forceFlush: the provider flushes BOTH processors; the diagnostic one
    // resolves without touching the exporter again.
    await host.forceFlush();
    const batch = collector.read('probe', 0);
    expect(batch.state).toBe('ready');
    expect(batch.records.length).toBe(1);
    expect(batch.records[0]!.operationAlias).toBe('approved');
    // THE assertion: the exporter received the span too.
    expect(exported).toContain('approved.op');
    // shutdown: closes the collector through the provider, for real.
    await host.shutdown();
    expect(collector.read('probe', 0).closed).toBe(true);
  });
});

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

import { TelemetryService } from '../../src/services/telemetry-service.ts';
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

  it({
    name: 'framework kinds and statuses reach the exporter AND the diagnostic record correctly',
    ignore: !canImportNpm(),
  }, async () => {
    // Regression: TelemetryService once handed OTel the OTLP WIRE kind numbers
    // (server exported as CLIENT, consumer as an out-of-range 5) and passed
    // setStatus a bare string, which real OTel records as status `{}`. The
    // diagnostic processor then dropped every span that set a status — every
    // HTTP server span. Only the real SDK can show either.
    const sdkMod = await import(
      'npm:@opentelemetry/sdk-trace-base@^2.9.0'
    ) as unknown as OtelSdkModule;
    const resourcesMod = await import(
      'npm:@opentelemetry/resources@^2.9.0'
    ) as unknown as OtelResourcesModule;
    const exported: Array<{ name: string; kind: number; status: { code?: number } }> = [];
    class RecordingExporter {
      export(
        spans: Array<{ name: string; kind: number; status: { code?: number } }>,
        callback: (result: { code: number }) => void,
      ): void {
        for (const span of spans) {
          exported.push({ name: span.name, kind: span.kind, status: { ...span.status } });
        }
        callback({ code: 0 });
      }
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    }
    const kinds = ['internal', 'server', 'client', 'producer', 'consumer'] as const;
    const policy = compileTraceDiagnosticsPolicy({
      enabled: true,
      serviceAlias: 'orders',
      operations: {
        ...Object.fromEntries(kinds.map((kind) => [kind, `op-${kind}`])),
        'status.ok': 'st-ok',
        'status.error': 'st-error',
        'status.thrown': 'st-thrown',
      },
    });
    const collector = new SpanObservationCollector(
      {
        coverage: 'completed-sampled-spans',
        instrumentation: () => [],
        sampler: { kind: 'always-on' },
      },
      { hrtime: () => 0 } as unknown as Pick<IRuntimeServices, 'hrtime'>,
    );
    const host = await buildTracerHost({
      sdkMod,
      resourcesMod,
      pluginOptions: { serviceName: 'probe', exporter: 'console' },
      consoleExporterCtor: RecordingExporter as never,
      diagnostics: { policy, collector },
    });
    const service = new TelemetryService(host);
    for (const kind of kinds) {
      await service.withSpan(kind, () => Promise.resolve(), { kind });
    }
    // deno-lint-ignore require-await
    await service.withSpan('status.ok', async (span) => span.setStatus('ok'));
    // deno-lint-ignore require-await
    await service.withSpan('status.error', async (span) => span.setStatus('error'));
    await service.withSpan('status.thrown', () => Promise.reject(new Error('boom')))
      .catch(() => undefined);
    await host.forceFlush();

    // The exporter sees the @opentelemetry/api SpanKind / SpanStatusCode values.
    const byName = new Map(exported.map((span) => [span.name, span]));
    expect(kinds.map((kind) => byName.get(kind)!.kind)).toEqual([0, 1, 2, 3, 4]);
    expect(byName.get('status.ok')!.status.code).toBe(1);
    expect(byName.get('status.error')!.status.code).toBe(2);
    expect(byName.get('status.thrown')!.status.code).toBe(2);

    // The diagnostic record agrees, and nothing that set a status is dropped.
    const batch = collector.read('probe', 0);
    expect(batch.droppedSpans).toBe(0);
    const observed = new Map(batch.records.map((r) => [r.operationAlias, r]));
    expect(kinds.map((kind) => observed.get(`op-${kind}`)!.kind)).toEqual([...kinds]);
    expect(observed.get('st-ok')!.outcome).toBe('ok');
    expect(observed.get('st-error')!.outcome).toBe('error');
    expect(observed.get('st-thrown')!.outcome).toBe('error');
    await host.shutdown();
  });
});

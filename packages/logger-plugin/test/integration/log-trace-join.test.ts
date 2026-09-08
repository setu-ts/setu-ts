// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages, and
// the ConsoleLogger sink under test IS `console.log`.
/**
 * X34-2 end to end — the join itself, through a real kernel application with
 * the real `LoggerPlugin` and `TelemetryPlugin`.
 *
 * The unit suite proves the decorator merges what it is handed. It cannot prove
 * that the identifier a log record carries is the SAME one the exported span
 * reports, which is the whole finding: "an operator holding a trace id from a
 * dashboard cannot find the log lines". That needs a real span, really active,
 * and a real log line emitted inside it.
 *
 * Guarded: skipped when the optional OTel packages cannot be resolved.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, ITelemetryService } from '@setu-ts/common';
import { TelemetryPlugin } from '../../../telemetry-plugin/src/plugin/telemetry-plugin.ts';
import { buildTracerHost, setOtelApi } from '../../../telemetry-plugin/src/tracing/tracer.ts';
import { loadAsyncLocalStorageContextManager } from '../../../telemetry-plugin/src/tracing/context-manager.ts';
import type { TracerHost } from '../../../telemetry-plugin/src/interfaces/index.ts';
import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';

/** A finished span reduced to its identity. */
interface FinishedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
}

interface RealOtel {
  readonly host: TracerHost;
  readonly finished: () => Promise<readonly FinishedSpan[]>;
}

/**
 * Builds the tracer host through the REAL {@linkcode buildTracerHost}, not a
 * hand-written stand-in, because `activeSpanContext` is defined THERE — a
 * hand-written host would be testing this file's own code.
 *
 * @returns The host and a span reader, or `null` when the packages are absent
 */
async function realOtel(): Promise<RealOtel | null> {
  let api: typeof import('npm:@opentelemetry/api@^1.9.0');
  let sdk: typeof import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
  let resources: typeof import('npm:@opentelemetry/resources@^2.9.0');
  try {
    api = await import('npm:@opentelemetry/api@^1.9.0');
    sdk = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
    resources = await import('npm:@opentelemetry/resources@^2.9.0');
    const manager = await loadAsyncLocalStorageContextManager();
    api.context.setGlobalContextManager(manager as never);
  } catch {
    return null;
  }

  setOtelApi(api as never);
  const exporter = new sdk.InMemorySpanExporter();
  const host = buildTracerHost({
    sdkMod: sdk as never,
    resourcesMod: resources as never,
    pluginOptions: { serviceName: 'm90i-log-join', exporter: 'console' },
    // The console-exporter seam, handed the in-memory exporter so finished
    // spans are inspectable rather than printed.
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
      return exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      }));
    },
  };
}

const otel = await realOtel();

/** Captures the JSON lines the real ConsoleLogger writes. */
function captureConsole(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const real = console.log;
  console.log = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      real(line);
    }
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

describe('log ↔ trace join, through a real application', () => {
  it("a log line emitted inside a span carries THAT span's ids", async () => {
    if (!otel) {
      console.warn('skipped: optional OpenTelemetry packages are not resolvable');
      return;
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin({ level: 'debug' }),
        TelemetryPlugin({
          serviceName: 'm90i-log-join',
          // REQUIRED: with no `exporter` the plugin registers
          // NoopTelemetryService and every span context is empty.
          exporter: 'console',
          middleware: false,
          tracerProviderFactory: () => Promise.resolve(otel.host),
        }),
      ],
    });
    await app.start();

    const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
    const telemetry = app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);

    const captured = captureConsole();
    let traceId = '';
    let spanId = '';
    try {
      await telemetry.withSpan('handle request', (span) => {
        traceId = span.spanContext().traceId;
        spanId = span.spanContext().spanId;
        logger.info('inside the span', { order: 'o-1' });
        // The framework's own request logging goes through `child()`.
        logger.child({ requestId: 'r-1' }).info('from a child logger');
        return Promise.resolve();
      });
      logger.info('outside any span');
    } finally {
      captured.restore();
    }

    // Spans are read BEFORE `stop()`: the plugin's onClose shuts the provider
    // down and `InMemorySpanExporter.shutdown()` RESETS its store, after which
    // every identity assertion would compare `undefined` to `undefined` and
    // pass vacuously.
    const spans = await otel.finished();
    await app.stop();

    const exported = spans.find((s) => s.name === 'handle request');
    expect(exported).toBeDefined();
    expect(traceId).not.toBe('');

    const inside = captured.lines.find((l) => l.msg === 'inside the span');
    const fromChild = captured.lines.find((l) => l.msg === 'from a child logger');
    const outside = captured.lines.find((l) => l.msg === 'outside any span');
    expect(inside).toBeDefined();
    expect(fromChild).toBeDefined();
    expect(outside).toBeDefined();

    // The join: the record names the trace the EXPORTED span belongs to.
    expect(inside?.trace_id).toBe(exported?.traceId);
    expect(inside?.span_id).toBe(exported?.spanId);
    expect(inside?.trace_id).toBe(traceId);
    expect(inside?.span_id).toBe(spanId);
    expect(inside?.order).toBe('o-1');

    // A child logger joins too, and keeps its bindings.
    expect(fromChild?.trace_id).toBe(traceId);
    expect(fromChild?.requestId).toBe('r-1');

    // Outside any span there is nothing honest to report.
    expect(outside?.trace_id).toBeUndefined();
    expect(outside?.span_id).toBeUndefined();
  });
});

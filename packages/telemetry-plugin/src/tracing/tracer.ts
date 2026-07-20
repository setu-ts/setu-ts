/**
 * OTel tracer provider loader and TracerHost seam.
 *
 * @module
 * @since 0.24.0
 */

import type { TelemetryPluginOptions, TracerHost } from '../interfaces/index.ts';
import { loadOtlpExporter } from '../exporters/otlp-exporter.ts';
import { loadConsoleExporter } from '../exporters/console-exporter.ts';

/**
 * Lazy-loads the OpenTelemetry SDK and builds a `TracerHost`.
 *
 * Uses the **2.x constructor-config** shape — `addSpanProcessor()` does not
 * exist on `BasicTracerProvider` in the 2.x line.
 *
 * @param options - Plugin options controlling exporter, sampling, etc.
 * @returns A `TracerHost` wrapping the OTel provider
 * @throws {Error} If the npm package is not installed or required options are missing
 */
export async function loadOtelTracerProvider(
  options: TelemetryPluginOptions,
): Promise<TracerHost> {
  const { serviceName = 'hono-app', serviceVersion = '1.0.0' } = options;

  // Lazy-load sdk-trace-base
  const sdkMod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
  // Lazy-load resources
  const resourcesMod = await import('npm:@opentelemetry/resources@^2.9.0');

  const { BasicTracerProvider, SimpleSpanProcessor, TraceIdRatioBasedSampler, AlwaysOnSampler } =
    sdkMod;
  const { resourceFromAttributes } = resourcesMod;

  // Build resource
  const resourceAttrs: Record<string, string> = {
    'service.name': serviceName,
  };
  if (serviceVersion) {
    resourceAttrs['service.version'] = serviceVersion;
  }
  const resource = resourceFromAttributes(resourceAttrs);

  // Build exporter
  let exporter: unknown;
  const exporterKind = options.exporter;

  if (exporterKind === 'otlp') {
    if (!options.endpoint) {
      throw new Error(
        `TelemetryPlugin: 'endpoint' is required when exporter is 'otlp'`,
      );
    }
    // Verify the exporter package loads
    await loadOtlpExporter(options.endpoint, options.headers);
    const OTLPTraceExporterCtor = await loadOtlpExporter(
      options.endpoint,
      options.headers,
    );
    const exporterArgs: { url: string; headers?: Record<string, string> } = {
      url: options.endpoint,
    };
    if (options.headers) {
      exporterArgs.headers = options.headers;
    }
    exporter = new OTLPTraceExporterCtor(exporterArgs);
  } else if (exporterKind === 'console') {
    const ConsoleSpanExporter = await loadConsoleExporter();
    exporter = new ConsoleSpanExporter();
  } else {
    throw new Error(
      `TelemetryPlugin: exporter must be 'otlp' or 'console' when using real mode`,
    );
  }

  // Build sampler
  let sampler: unknown;
  if (options.sampling?.type === 'traceidratio') {
    sampler = new TraceIdRatioBasedSampler(
      options.sampling.ratio ?? 1.0,
    );
  } else {
    sampler = new AlwaysOnSampler();
  }

  // Build provider via constructor config (2.x API)
  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(exporter as never)],
    sampler: sampler as never,
  });

  const tracer = provider.getTracer(serviceName, serviceVersion);

  return {
    startSpan(
      name: string,
      spanOptions?: {
        kind?: number;
        attributes?: Record<string, unknown>;
        parentContext?: unknown;
      },
    ) {
      const otelSpanOptions: Record<string, unknown> = {};
      if (spanOptions?.attributes) {
        otelSpanOptions.attributes = spanOptions.attributes;
      }
      if (spanOptions?.kind !== undefined) {
        otelSpanOptions.kind = spanOptions.kind;
      }
      return tracer.startSpan(name, otelSpanOptions);
    },
    extractContext(_headers: Headers) {
      // In real OTel mode, this would use the context module.
      // For now we return a placeholder context.
      // deno-lint-ignore no-explicit-any
      return { _opaque: Symbol.for('telemetry-context') } as any;
    },
    injectContext(_context: unknown) {
      return {};
    },
    shutdown: () => provider.shutdown(),
    forceFlush: () => provider.forceFlush(),
  };
}

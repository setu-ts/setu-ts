/**
 * OTel tracer provider loader and TracerHost seam.
 *
 * @module
 * @since 0.24.0
 */

import type { TelemetryPluginOptions, TracerHost } from '../interfaces/index.ts';
import { TELEMETRY_CONTEXT_OPAQUE, type TelemetryContext } from '@hono-enterprise/common';
import { loadOtlpExporter } from '../exporters/otlp-exporter.ts';
import { loadConsoleExporter } from '../exporters/console-exporter.ts';

/**
 * Module handle returned by lazy-loading `npm:@opentelemetry/sdk-trace-base`.
 *
 * @internal
 */
export interface OtelSdkModule {
  BasicTracerProvider: new (config: {
    resource: unknown;
    spanProcessors: unknown[];
    sampler: unknown;
  }) => {
    getTracer(
      name: string,
      version?: string,
    ): {
      startSpan(
        name: string,
        options?: Record<string, unknown>,
      ): unknown;
    };
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
  };
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
  TraceIdRatioBasedSampler: new (ratio: number) => unknown;
  AlwaysOnSampler: new () => unknown;
}

/**
 * Module handle returned by lazy-loading `npm:@opentelemetry/resources`.
 *
 * @internal
 */
export interface OtelResourcesModule {
  resourceFromAttributes(attrs: Record<string, string>): unknown;
}

/**
 * OTLP exporter constructor type.
 *
 * @internal
 */
export type OtlpExporterCtor = new (
  args?: { url?: string; headers?: Record<string, string> },
) => unknown;

/**
 * Console span exporter constructor type.
 *
 * @internal
 */
export type ConsoleExporterCtor = new () => unknown;

/**
 * Options for building a TracerHost from already-loaded modules.
 *
 * @internal
 */
export interface BuildTracerHostOptions {
  sdkMod: OtelSdkModule;
  resourcesMod: OtelResourcesModule;
  pluginOptions: TelemetryPluginOptions;
  /** OTLP exporter constructor — required when `pluginOptions.exporter === 'otlp'`. */
  otlpExporterCtor?: OtlpExporterCtor;
  /** Console span exporter constructor — required when `pluginOptions.exporter === 'console'`. */
  consoleExporterCtor?: ConsoleExporterCtor;
}

/**
 * Builds a `TracerHost` from already-loaded OTel modules.
 *
 * This function isolates all post-import logic so it can be tested
 * with fake modules — the only truly unreachable line is the
 * `await import(...)` in `loadOtelTracerProvider`.
 *
 * The exporter constructor must be provided via `otlpExporterCtor` or
 * `consoleExporterCtor`; lazy-loading fallbacks are handled by
 * [loadOtelTracerProvider][].
 *
 * @internal
 */
export function buildTracerHost(opts: BuildTracerHostOptions): TracerHost {
  const { sdkMod, resourcesMod, pluginOptions } = opts;

  const {
    BasicTracerProvider,
    SimpleSpanProcessor,
    TraceIdRatioBasedSampler,
    AlwaysOnSampler,
  } = sdkMod;
  const { resourceFromAttributes } = resourcesMod;

  const { serviceName = 'hono-app', serviceVersion = '1.0.0' } = pluginOptions;

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
  const exporterKind = pluginOptions.exporter;

  if (exporterKind === 'otlp') {
    // Early validation guarantees endpoint is set
    const endpoint = pluginOptions.endpoint!;
    const OTLPTraceExporterCtor = opts.otlpExporterCtor;
    if (!OTLPTraceExporterCtor) {
      throw new Error(
        'TelemetryPlugin: otlpExporterCtor is required when exporter is "otlp"',
      );
    }

    const exporterArgs: { url: string; headers?: Record<string, string> } = {
      url: endpoint,
    };
    if (pluginOptions.headers) {
      exporterArgs.headers = pluginOptions.headers;
    }
    exporter = new OTLPTraceExporterCtor(exporterArgs);
  } else if (exporterKind === 'console') {
    const ConsoleSpanExporter = opts.consoleExporterCtor;
    if (!ConsoleSpanExporter) {
      throw new Error(
        'TelemetryPlugin: consoleExporterCtor is required when exporter is "console"',
      );
    }
    exporter = new ConsoleSpanExporter();
  } else {
    throw new Error(
      `TelemetryPlugin: exporter must be 'otlp' or 'console' when using real mode`,
    );
  }

  // Build sampler
  let sampler: unknown;
  if (pluginOptions.sampling?.type === 'traceidratio') {
    sampler = new TraceIdRatioBasedSampler(
      pluginOptions.sampling.ratio ?? 1.0,
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
    extractContext(_headers: Headers): TelemetryContext {
      // In real OTel mode, this would use the context module.
      // For now we return a placeholder context.
      return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
    },
    injectContext(_context: unknown) {
      return {};
    },
    shutdown: () => provider.shutdown(),
    forceFlush: () => provider.forceFlush(),
  };
}

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
  // Validate options BEFORE lazy-loading (fail fast, avoid unnecessary imports)
  if (options.exporter === 'otlp' && !options.endpoint) {
    throw new Error(
      `TelemetryPlugin: 'endpoint' is required when exporter is 'otlp'`,
    );
  }
  if (options.exporter && options.exporter !== 'otlp' && options.exporter !== 'console') {
    throw new Error(
      `TelemetryPlugin: exporter must be 'otlp' or 'console' when using real mode`,
    );
  }

  // Lazy-load sdk-trace-base
  const sdkMod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
  // Lazy-load resources
  const resourcesMod = await import('npm:@opentelemetry/resources@^2.9.0');

  // Build exporter constructors from loaded modules
  let otlpExporterCtor: OtlpExporterCtor | undefined;
  let consoleExporterCtor: ConsoleExporterCtor | undefined;

  if (options.exporter === 'otlp') {
    otlpExporterCtor = (await loadOtlpExporter(
      options.endpoint!,
      options.headers,
    )) as OtlpExporterCtor;
  } else if (options.exporter === 'console') {
    consoleExporterCtor = (await loadConsoleExporter()) as ConsoleExporterCtor;
  }

  // Build and return the TracerHost using the loaded modules
  const buildOpts: BuildTracerHostOptions = {
    sdkMod: sdkMod as OtelSdkModule,
    resourcesMod: resourcesMod as OtelResourcesModule,
    pluginOptions: options,
  };
  if (otlpExporterCtor) {
    buildOpts.otlpExporterCtor = otlpExporterCtor;
  }
  if (consoleExporterCtor) {
    buildOpts.consoleExporterCtor = consoleExporterCtor;
  }
  return buildTracerHost(buildOpts);
}

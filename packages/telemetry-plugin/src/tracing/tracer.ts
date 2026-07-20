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

// OTel API handle — populated by loadOtelTracerProvider when the SDK is loaded.
let _otelApi: unknown;

// Public setter called by loadOtelTracerProvider after importing @opentelemetry/api.
export function setOtelApi(api: unknown): void {
  _otelApi = api;
}

// deno-lint-ignore no-explicit-any
function getOtelApi(): any {
  return _otelApi || null;
}

// --- W3C traceparent propagation helpers ---

/** W3C traceparent regex: version-traceId-parentId-flags. */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * Parses a W3C `traceparent` header into a `TelemetryContext`.
 *
 * Returns a context with `{ _opaque: TELEMETRY_CONTEXT_OPAQUE, traceId, spanId, traceFlags }`
 * when the header is valid and version `"00"`; otherwise returns a minimal context
 * (`{ _opaque }`) indicating no extractable parent.
 */
/**
 * Parses a W3C `traceparent` header into a `TelemetryContext`.
 *
 * Returns a context with `{ _opaque: TELEMETRY_CONTEXT_OPAQUE, traceId, spanId, traceFlags }`
 * when the header is valid and version `"00"`; otherwise returns a minimal context
 * (`{ _opaque }`) indicating no extractable parent.
 *
 * @internal
 */
export function parseTraceparentToContext(
  header: string | null,
): TelemetryContext {
  if (!header) {
    return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  }
  const m = TRACEPARENT_RE.exec(header);
  if (!m) {
    return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  }
  const [, version, traceId, spanId, flags] = m;
  // Only version "00" is defined by the W3C spec
  if (version !== '00') {
    return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  }
  return {
    _opaque: TELEMETRY_CONTEXT_OPAQUE,
    traceId,
    spanId,
    traceFlags: flags,
  };
}

/**
 * Extracts `traceparent` / `tracestate` from incoming headers and returns a
 * `TelemetryContext` suitable for span parenting.
 */
/**
 * Extracts `traceparent` / `tracestate` from incoming headers and returns a
 * `TelemetryContext` suitable for span parenting.
 *
 * @internal
 */
export function extractContextFromHeaders(headers: Headers): TelemetryContext {
  const traceparent = headers.get('traceparent');
  const tracestate = headers.get('tracestate');
  const ctx = parseTraceparentToContext(traceparent);
  if (tracestate) {
    return { ...ctx, tracestate };
  }
  return ctx;
}

/**
 * Serialises a `TelemetryContext` into a W3C `traceparent` header string.
 *
 * When the context carries `traceId` + `spanId` + `traceFlags` the output is
 * a valid header (`00-<traceId>-<spanId>-<flags>`).  Otherwise returns `null`
 * so callers can skip injection.
 */
/**
 * Serialises a `TelemetryContext` into a W3C `traceparent` header string.
 *
 * When the context carries `traceId` + `spanId` + `traceFlags` the output is
 * a valid header (`00-<traceId>-<spanId>-<flags>`).  Otherwise returns `null`
 * so callers can skip injection.
 *
 * @internal
 */
export function contextToTraceparent(context: TelemetryContext): string | null {
  if (!context.traceId || !context.spanId) {
    return null;
  }
  const flags = context.traceFlags ?? '01';
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

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
        context?: unknown,
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
  /**
   * When `true`, skips re-validating `pluginOptions.exporter` / `pluginOptions.endpoint`
   * because the caller (e.g. {@linkcode loadOtelTracerProvider}) already did so.
   *
   * @internal
   */
  validated?: boolean;
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
    const endpoint = opts.validated
      ? pluginOptions.endpoint!
      // buildTracerHost is sometimes called directly by tests with unvalidated options.
      // When not pre-validated, re-check endpoint here.
      : (pluginOptions.endpoint ?? (() => {
        throw new Error(
          "TelemetryPlugin: 'endpoint' is required when exporter is 'otlp'",
        );
      })())!;
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
  } else if (!opts.validated) {
    throw new Error(
      `TelemetryPlugin: exporter must be 'otlp' or 'console' when using real mode`,
    );
  } else {
    // validated mode but no exporter — should not happen; treat as noop.
    exporter = null;
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
        parentContext?: TelemetryContext;
      },
    ) {
      const otelSpanOptions: Record<string, unknown> = {};
      if (spanOptions?.attributes) {
        otelSpanOptions.attributes = spanOptions.attributes;
      }
      if (spanOptions?.kind !== undefined) {
        otelSpanOptions.kind = spanOptions.kind;
      }

      // N1 fix: build an OTel parent context and pass it as the 3rd arg.
      // OTel's `Tracer.startSpan(name, options, context)` reads the parent
      // from `context` via `api.trace.getSpan(context)`, NOT from
      // `options.parentContext`. We keep `parentContext` in `otelSpanOptions`
      // for backward-compat with tests that inspect the 2nd arg, and also
      // pass it as the 3rd arg for real OTel.
      let parentContext: unknown | undefined;
      if (spanOptions?.parentContext) {
        otelSpanOptions.parentContext = spanOptions.parentContext;
        const pc = spanOptions.parentContext;
        if (pc.traceId && pc.spanId) {
          const api = getOtelApi();
          if (api) {
            const traceFlags = parseInt(pc.traceFlags ?? '01', 16);
            const spanContext = {
              traceId: pc.traceId,
              spanId: pc.spanId,
              traceFlags,
              isRemote: true,
            };
            const parentSpan = api.trace.wrapSpanContext(spanContext);
            parentContext = api.trace.setSpan(
              api.context.active(),
              parentSpan,
            );
          }
        }
      }

      return tracer.startSpan(name, otelSpanOptions, parentContext);
    },
    extractContext(headers: Headers): TelemetryContext {
      return extractContextFromHeaders(headers);
    },
    injectContext(context: TelemetryContext): Record<string, string> {
      const header = contextToTraceparent(context);
      if (header) {
        return { traceparent: header };
      }
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
  // Lazy-load the OTel API (transitive dep of sdk-trace-base) for span parenting.
  // deno-lint-ignore no-explicit-any
  const apiMod = await import('npm:@opentelemetry/api@^1.9.0') as any;
  setOtelApi(apiMod);

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

  // Build and return the TracerHost using the loaded modules.
  const buildOpts: BuildTracerHostOptions = {
    sdkMod: sdkMod as OtelSdkModule,
    resourcesMod: resourcesMod as OtelResourcesModule,
    pluginOptions: options,
    validated: true, // loadOtelTracerProvider already validated above
  };
  if (otlpExporterCtor) {
    buildOpts.otlpExporterCtor = otlpExporterCtor;
  }
  if (consoleExporterCtor) {
    buildOpts.consoleExporterCtor = consoleExporterCtor;
  }
  return buildTracerHost(buildOpts);
}

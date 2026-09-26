/**
 * Telemetry plugin factory.
 *
 * Creates a plugin that registers an `ITelemetryService` under
 * `CAPABILITIES.TELEMETRY` (`'telemetry'`).
 *
 * @module
 * @since 0.2.0
 */

import type {
  ILogger,
  IPlugin,
  IRedactionService,
  ITelemetryService,
  ITraceDiagnosticsSource,
  MiddlewareFunction,
  TelemetryContext,
  TraceCoverage,
  TraceInstrumentationKind,
  TraceSamplerDescription,
} from '@setu-ts/common';
import { CAPABILITIES, createRedactionService } from '@setu-ts/common';
import type { RedactionPolicy } from '@setu-ts/common';
import type { SamplingConfig, TelemetryPluginOptions, TracerHost } from '../interfaces/index.ts';
import { NoopTelemetryService, TelemetryService } from '../services/telemetry-service.ts';
import { telemetryMiddleware } from '../middleware/telemetry-middleware.ts';
import { contextToTraceparent, extractContextFromHeaders } from '@setu-ts/common';
import {
  buildInstrumentationRegistry,
  type InstrumentationReporter,
} from '../instrumentation/instrumentation-registry.ts';
import type { BuildTracerHostOptions, ContextActivationReporter } from '../tracing/tracer.ts';
import {
  compileTraceDiagnosticsPolicy,
  createInactiveTraceSource,
  SpanObservationCollector,
} from '../diagnostics/span-observation-collector.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Middleware priority for telemetry (inside metrics at 20, outside auth at 300).
 *
 * @internal
 */
const MIDDLEWARE_PRIORITY = {
  TELEMETRY: 30,
} as const;

/**
 * The fixed reporting order for instrumentation coverage (M98g): the trace
 * source reports enabled kinds in this order regardless of the order the
 * registry happened to enable them.
 *
 * @internal
 */
const TRACE_INSTRUMENTATION_ORDER: readonly TraceInstrumentationKind[] = [
  'http',
  'fetch',
  'ioredis',
  'amqplib',
  'kafkajs',
];

/**
 * Resolves the sampler description the trace source reports (M98g), matching
 * what the built-in provider constructs from the same configuration. A
 * non-`'traceidratio'` configuration is the provider's always-on sampler. A
 * ratio is reported projected onto the sampler's documented `[0, 1]` domain
 * — the value the provider actually bounds with; a non-finite ratio cannot
 * be described and is reported as `unknown` rather than improvised.
 *
 * @param sampling - The configured sampling options
 * @returns The sampler description
 * @internal
 */
function resolveTraceSampler(sampling: SamplingConfig | undefined): TraceSamplerDescription {
  if (sampling?.type !== 'traceidratio') {
    return { kind: 'always-on' };
  }
  const configured = sampling.ratio ?? 1.0;
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'traceidratio',
    ratio: Math.min(Math.max(configured, 0), 1),
  };
}

/**
 * Builds the instrumentation-outcome reporter. `ctx.logger` is read **at call
 * time** rather than captured at plugin construction: a logger registered
 * imperatively after this plugin must still receive the lines (the M52b
 * lesson). `debug` for an enabled instrumentation, `warn` for a failure — a
 * failure remains a no-op, never a throw.
 *
 * The plugin declares `CAPABILITIES.LOGGER` in `optionalDependencies` (below):
 * the kernel resolver creates a registration-ordering edge from that entry, so
 * a plugin-provided logger (e.g. `LoggerPlugin`) registers BEFORE this plugin
 * and the call-time read finds it. The edge is optional, not required: an app
 * without any logger plugin must still boot, with the outcomes recorded on the
 * registry handle and nothing emitted.
 */
function createInstrumentationReporter(ctx: { logger?: ILogger }): InstrumentationReporter {
  return (outcome) => {
    const logger = ctx.logger;
    if (!logger) return;
    if (outcome.enabled) {
      logger.debug(`Auto-instrumentation enabled: ${outcome.kind}`, { kind: outcome.kind });
    } else {
      logger.warn(`Auto-instrumentation unavailable: ${outcome.kind}`, {
        kind: outcome.kind,
        reason: outcome.reason,
      });
    }
  };
}

/**
 * Builds the span-activation outcome reporter. Like the instrumentation
 * reporter above, `ctx.logger` is read **at call time** so a logger registered
 * imperatively after this plugin is still found (the M52b lesson).
 *
 * Activation is an enhancement, never a requirement: a failure is a `warn`
 * naming the reason, not a throw, because a trace with unnested spans is worth
 * more than an application that will not boot.
 *
 * @param ctx - The plugin context whose logger is read at call time
 * @returns A reporter that logs the activation outcome
 */
function createActivationReporter(ctx: { logger?: ILogger }): ContextActivationReporter {
  return (outcome) => {
    const logger = ctx.logger;
    if (!logger) return;
    if (outcome.activated) {
      logger.debug(
        `Span context activation available (${outcome.adopted} context manager)`,
        { adopted: outcome.adopted },
      );
      return;
    }
    logger.warn(
      `Span context activation unavailable; spans will not nest: ${outcome.reason}`,
      { reason: outcome.reason },
    );
  };
}

/**
 * Creates a telemetry plugin.
 *
 * Registers an `ITelemetryService` under `CAPABILITIES.TELEMETRY` and,
 * by default, adds request-span middleware at priority 30.
 *
 * When no `exporter` is configured, a `NoopTelemetryService` is registered
 * (zero dependencies). When `exporter` is `'otlp'` or `'console'`, the
 * plugin lazy-loads the OTel SDK and registers a real `TelemetryService`.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers `ITelemetryService` under `'telemetry'`
 *
 * @example
 * ```typescript
 * // Noop mode (zero deps)
 * app.register(TelemetryPlugin({ serviceName: 'my-app' }));
 *
 * // Real OTel mode with console exporter
 * app.register(TelemetryPlugin({
 *   serviceName: 'my-app',
 *   exporter: 'console',
 * }));
 *
 * // Real OTel mode with OTLP exporter
 * app.register(TelemetryPlugin({
 *   serviceName: 'my-app',
 *   exporter: 'otlp',
 *   endpoint: 'http://otel:4318/v1/traces',
 * }));
 * ```
 * @since 0.2.0
 */
export function TelemetryPlugin(options: TelemetryPluginOptions = {}): IPlugin {
  const middlewareEnabled = options.middleware !== false;
  const queryParameters = options.queryParameters ?? 'omit';
  const redaction = resolveRedaction(options.redaction);
  // M98g — the trace-observation policy is compiled ONCE at construction, so
  // an invalid option refuses before any application exists.
  const tracePolicy = options.diagnostics === undefined
    ? null
    : compileTraceDiagnosticsPolicy(options.diagnostics);
  // The tracing stack's coverage is fixed by the configuration: a custom
  // provider factory owns its own provider the plugin cannot read; noop mode
  // builds none; otherwise every completed SAMPLED span of the built-in
  // provider reaches the diagnostic processor.
  const traceCoverage: TraceCoverage = options.tracerProviderFactory !== undefined
    ? 'custom-provider'
    : options.exporter === undefined
    ? 'noop-no-provider'
    : 'completed-sampled-spans';
  // The sampler description answers only where the plugin builds the
  // provider: a custom host owns its own sampler and noop mode builds none,
  // so both report `unknown` rather than a configuration that never applied.
  const traceSampler: TraceSamplerDescription = traceCoverage === 'completed-sampled-spans'
    ? resolveTraceSampler(options.sampling)
    : { kind: 'unknown' };

  return {
    name: 'telemetry-plugin',
    version: denoJson.version,
    provides: [CAPABILITIES.TELEMETRY, CAPABILITIES.TRACE_DIAGNOSTICS],
    // Optional edge on the logger capability: the kernel resolver orders the
    // provider (e.g. LoggerPlugin) before this plugin so the outcome reporter's
    // call-time read of ctx.logger finds it in the standard configuration.
    // Optional — an app without a logger plugin must still boot.
    optionalDependencies: [CAPABILITIES.LOGGER],
    priority: MIDDLEWARE_PRIORITY.TELEMETRY,

    async register(ctx) {
      let service: ITelemetryService;
      let tracerHost: TracerHost | undefined;
      let instrumentationHandle: { shutdown(): Promise<void> } | null = null;
      // M98g — which Node-only instrumentations actually enabled is learned
      // from the registry outcomes and read through this set at READ time
      // (the M52b capture-too-early lesson), never guessed at construction.
      const enabledInstrumentations = new Set<TraceInstrumentationKind>();
      const traceAvailability = {
        coverage: traceCoverage,
        instrumentation: () =>
          TRACE_INSTRUMENTATION_ORDER.filter((kind) => enabledInstrumentations.has(kind)),
        sampler: traceSampler,
      };
      let traceCollector: SpanObservationCollector | null = null;

      if (options.exporter) {
        // Real OTel mode
        if (options.tracerProviderFactory) {
          tracerHost = await options.tracerProviderFactory();
        } else {
          // The active collector exists only on the built-in provider with
          // the diagnostics option; the tracer appends its processor after
          // the exporter processor in the same provider constructor.
          if (tracePolicy !== null) {
            traceCollector = new SpanObservationCollector(traceAvailability, ctx.runtime);
          }
          tracerHost = await loadOtelTracerProvider(
            options,
            createActivationReporter(ctx),
            tracePolicy !== null && traceCollector !== null
              ? { policy: tracePolicy, collector: traceCollector }
              : undefined,
          );
        }
        service = new TelemetryService(tracerHost);

        // Build instrumentation registry after the host is obtained.
        // Only runs when all three conditions hold: instrumentations configured,
        // real mode (exporter set), and host exposes otelProvider.
        // Awaiting ensures all lazy loads complete BEFORE onShutdown is registered,
        // eliminating the shutdown-ordering race for the lazy path.
        if (options.instrumentations && tracerHost.otelProvider) {
          const baseReporter = createInstrumentationReporter(ctx);
          instrumentationHandle = await buildInstrumentationRegistry(
            options.instrumentations,
            ctx.runtime,
            tracerHost.otelProvider,
            (outcome) => {
              if (outcome.enabled) {
                enabledInstrumentations.add(outcome.kind);
              }
              baseReporter(outcome);
            },
          );
        }

        // Register shutdown hook: disable instrumentations first, then shut down the provider.
        // Provider shutdown also shuts down the M98g diagnostic processor,
        // which closes the trace collector AFTER the connector session's
        // own onStopping revocation has run.
        ctx.lifecycle.onShutdown(async () => {
          if (instrumentationHandle) {
            await instrumentationHandle.shutdown();
          }
          if (tracerHost) {
            await tracerHost.shutdown();
          }
        });
      } else {
        // Noop mode — instrumentations are a no-op (no exporter = no provider).
        service = new NoopTelemetryService();
      }

      // Register the service
      ctx.services.register<ITelemetryService>(CAPABILITIES.TELEMETRY, service);

      // M98g — ALWAYS register a trace-diagnostics source under the eager
      // token: the active collector when observation is enabled on the
      // built-in provider; an `unsupported`-answering source when the option
      // is present but the stack cannot supply completed spans (custom host,
      // noop mode); a `disabled`-answering one when the option is absent.
      const traceSource: ITraceDiagnosticsSource = traceCollector !== null
        ? traceCollector
        : createInactiveTraceSource(
          tracePolicy !== null ? 'unsupported' : 'disabled',
          traceAvailability,
        );
      ctx.services.register<ITraceDiagnosticsSource>(CAPABILITIES.TRACE_DIAGNOSTICS, traceSource);

      // Register middleware if enabled
      if (middlewareEnabled) {
        if (queryParameters === 'redact' && redaction === undefined) {
          ctx.logger?.warn(
            'Telemetry query-parameter redaction requested without a policy; omitting query strings',
          );
        }
        // Pass tracerHost to middleware for context extraction/injection (C1/C2/R2).
        // In noop mode, create a minimal TracerHost that still supports extractContext/injectContext.
        const host = tracerHost ?? createNoopTracerHost();
        const middleware: MiddlewareFunction = telemetryMiddleware(
          service,
          host,
          queryParameters,
          redaction,
        );
        ctx.middleware.add(middleware, {
          priority: MIDDLEWARE_PRIORITY.TELEMETRY,
          name: 'telemetry-middleware',
        });
      }
    },
  };
}

function resolveRedaction(
  redaction: RedactionPolicy | IRedactionService | undefined,
): IRedactionService | undefined {
  return redaction === undefined
    ? undefined
    : 'redactRecord' in redaction
    ? redaction
    : createRedactionService(redaction);
}

/**
 * Creates a minimal TracerHost for noop mode — supports extractContext/injectContext
 * so the middleware can run even when the service is NoopTelemetryService.
 *
 * Exported for test seam coverage of inner methods (startSpan, shutdown, forceFlush).
 *
 * N3 fix: reuses W3C helpers exported from `tracer.ts` instead of duplicating them.
 */
export function createNoopTracerHost(): TracerHost {
  return {
    startSpan(_name: string) {
      return {
        setAttribute: () => {},
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      };
    },
    extractContext(headers: Headers) {
      return extractContextFromHeaders(headers);
    },
    injectContext(context: TelemetryContext) {
      const header = contextToTraceparent(context);
      if (header) {
        return { traceparent: header };
      }
      return {};
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

async function loadOtelTracerProvider(
  options: TelemetryPluginOptions,
  reportActivation?: ContextActivationReporter,
  diagnostics?: BuildTracerHostOptions['diagnostics'],
): Promise<TracerHost> {
  const { loadOtelTracerProvider: loader } = await import('../tracing/tracer.ts');
  return loader(options, reportActivation, diagnostics);
}

export { telemetryMiddleware } from '../middleware/telemetry-middleware.ts';
export { NoopTelemetryService } from '../services/telemetry-service.ts';
export type { TracerHost } from '../interfaces/index.ts';
export type { SpanExporterKind, TelemetryPluginOptions } from '../interfaces/index.ts';
export { TELEMETRY_SPAN_KEY } from '../interfaces/index.ts';

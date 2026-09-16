/**
 * LoggerPlugin — registers a structured {@linkcode ILogger} under
 * `CAPABILITIES.LOGGER` and (optionally) request-logging middleware.
 *
 * @module
 */
import type {
  ILogger,
  IPlugin,
  IPluginContext,
  IRedactionService,
  IRuntimeServices,
  ITelemetryService,
  LogLevel,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  createRedactionService,
  DEFAULT_SECRET_FIELD_PATTERNS,
  PLUGIN_PRIORITY,
} from '@setu-ts/common';
import type { RedactionPolicy } from '@setu-ts/common';

import { ConsoleLogger } from '../loggers/console-logger.ts';
import { NoopLogger } from '../loggers/noop-logger.ts';
import { PinoLogger } from '../loggers/pino-logger.ts';
import type { PinoFactory, PinoLoggerOptions } from '../loggers/pino-logger.ts';
import { TraceEnrichedLogger } from '../loggers/trace-enriched-logger.ts';
import { createRequestLoggerMiddleware } from '../middleware/request-logger.ts';
import type { RequestLoggerOptions } from '../middleware/request-logger.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Selects the underlying logger implementation.
 *
 * - `'console'` — runtime-independent `console` output (default)
 * - `'pino'` — Pino-backed, lazy-loaded
 * - `'noop'` — discards all output
 *
 * @since 0.1.0
 */
export type LoggerTransport = 'console' | 'pino' | 'noop';

/**
 * Options for {@linkcode LoggerPlugin}.
 *
 * @since 0.1.0
 */
export interface LoggerPluginOptions {
  /** Minimum level to emit. Defaults to `'info'`. */
  readonly level?: LogLevel;
  /** Underlying logger implementation. Defaults to `'console'`. */
  readonly transport?: LoggerTransport;
  /** When `true` (and `transport: 'console'`), pretty-print entries. */
  readonly pretty?: boolean;
  /** Dot-paths to redact from metadata (e.g. `['password', 'token']`). */
  readonly redact?: readonly string[];
  /** A policy or service applied to every structured log record. */
  readonly redaction?: RedactionPolicy | IRedactionService;
  /** When `true`, register automatic request/response logging middleware. */
  readonly requestLogging?: boolean;
  /** Requests slower than this (ms) trigger a `warn` entry. Defaults to `5000`. */
  readonly slowRequestThreshold?: number;
  /** Exact paths excluded from request logging. */
  readonly excludePaths?: readonly string[];
  /**
   * Inject a pre-loaded Pino factory for the pino transport, bypassing
   * the `import('npm:pino')` path. Useful for tests.
   *
   * @since 0.1.0
   */
  readonly pinoFactory?: PinoFactory;
}

/** Default log level when none is configured. */
const DEFAULT_LEVEL: LogLevel = 'info';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'logger-plugin';

/**
 * Creates the LoggerPlugin.
 *
 * The plugin depends on the runtime plugin (`CAPABILITIES.RUNTIME`) and
 * registers its {@linkcode ILogger} under `CAPABILITIES.LOGGER` at
 * `PLUGIN_PRIORITY.HIGH` so logging is available before most other plugins
 * register.
 *
 * @example
 * ```typescript
 * import { LoggerPlugin } from '@setu-ts/logger-plugin';
 *
 * app.register(LoggerPlugin({
 *   level: 'debug',
 *   transport: 'console',
 *   pretty: true,
 *   redact: ['password', 'token'],
 *   requestLogging: true,
 *   slowRequestThreshold: 1000,
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function LoggerPlugin(options?: LoggerPluginOptions): IPlugin {
  const level = options?.level ?? DEFAULT_LEVEL;
  const transport = options?.transport ?? 'console';
  const requestLogging = options?.requestLogging ?? false;
  const redaction = resolveRedaction(options?.redaction);
  const loggerRedaction = composeLoggerRedaction(
    redaction,
    options?.redact ?? DEFAULT_SECRET_FIELD_PATTERNS,
  );

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    dependencies: ['runtime'],
    provides: [CAPABILITIES.LOGGER],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const logger = await createLogger(
        transport,
        level,
        runtime,
        options,
        redaction,
        loggerRedaction,
      );

      // X34-2: every record names the trace it was emitted in, so an operator
      // holding a trace id can find the log lines and vice versa.
      //
      // The telemetry capability is resolved at CALL time, never here, and that
      // is forced rather than merely careful: `TelemetryPlugin` declares
      // `CAPABILITIES.LOGGER` in its own `optionalDependencies`, so the kernel
      // orders THIS plugin first and telemetry is guaranteed absent right now.
      // Declaring the reverse edge to fix the ordering is not available either
      // — the two together are a cycle `resolvePluginOrder` refuses, which
      // would fail `start()` for every application registering both plugins.
      //
      // Absent telemetry the decorator is transparent: `activeSpanContext`
      // reports nothing and the record is byte-identical to an undecorated one.
      ctx.services.register<ILogger>(
        CAPABILITIES.LOGGER,
        new TraceEnrichedLogger(
          logger,
          () =>
            ctx.services.has(CAPABILITIES.TELEMETRY)
              ? ctx.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY)
              : undefined,
        ),
      );

      if (requestLogging) {
        const middlewareOptions: RequestLoggerOptions = buildRequestLoggerOptions(options);
        ctx.middleware.add(
          createRequestLoggerMiddleware(middlewareOptions),
          { name: 'request-logger', priority: PLUGIN_PRIORITY.HIGH },
        );
      }
    },
  };
}

/**
 * Instantiates the configured logger implementation.
 *
 * @param transport - Which implementation to build
 * @param level - Minimum log level
 * @param runtime - Runtime services (required by ConsoleLogger)
 * @param options - Original plugin options for redact/pretty/bindings
 * @returns A logger instance
 * @throws {Error} If `transport: 'pino'` and Pino cannot be imported
 */
async function createLogger(
  transport: LoggerTransport,
  level: LogLevel,
  runtime: IRuntimeServices,
  options?: LoggerPluginOptions,
  redaction?: IRedactionService,
  loggerRedaction?: IRedactionService,
): Promise<ILogger> {
  switch (transport) {
    case 'noop':
      return new NoopLogger({ level });
    case 'pino':
      return await PinoLogger.create(buildPinoLoggerOptions(level, options, loggerRedaction));
    case 'console':
    default:
      return new ConsoleLogger(runtime, buildConsoleOptions(level, options, redaction));
  }
}

/**
 * Builds `PinoLoggerOptions` without ever assigning `undefined` to an optional
 * property (required by `exactOptionalPropertyTypes`).
 *
 * @param level - Minimum log level
 * @param options - Source plugin options
 * @returns Options for `PinoLogger`
 */
function buildPinoLoggerOptions(
  level: LogLevel,
  options?: LoggerPluginOptions,
  redaction?: IRedactionService,
): PinoLoggerOptions {
  const base: {
    level: LogLevel;
    redact?: readonly string[];
    pinoFactory?: PinoFactory;
    redaction?: IRedactionService;
  } = { level };
  if (options?.redact !== undefined) base.redact = options.redact;
  if (options?.pinoFactory !== undefined) {
    base.pinoFactory = options.pinoFactory;
  }
  if (redaction !== undefined) base.redaction = redaction;
  return base as PinoLoggerOptions;
}

/**
 * Builds `ConsoleLoggerOptions` without ever assigning `undefined` to an
 * optional property (required by `exactOptionalPropertyTypes`).
 *
 * @param level - Minimum log level
 * @param options - Source plugin options
 * @returns Options for `ConsoleLogger`
 */
function buildConsoleOptions(
  level: LogLevel,
  options?: LoggerPluginOptions,
  redaction?: IRedactionService,
): {
  level: LogLevel;
  pretty?: boolean;
  redact?: readonly string[];
  redaction?: IRedactionService;
} {
  const base: {
    level: LogLevel;
    pretty?: boolean;
    redact?: readonly string[];
    redaction?: IRedactionService;
  } = {
    level,
    redact: options?.redact ?? DEFAULT_SECRET_FIELD_PATTERNS,
  };
  if (options?.pretty !== undefined) {
    base.pretty = options.pretty;
  }
  if (redaction !== undefined) {
    base.redaction = redaction;
  }
  return base;
}

/** Compiles a policy option or returns an already-compiled redaction service. */
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
 * Combines an optional policy service with the legacy logger path list.
 * Internal test seam; not re-exported from the package barrel.
 *
 * @param policy - Optional application policy service
 * @param paths - Legacy logger paths, applied after the policy
 * @returns Combined service
 */
export function composeLoggerRedaction(
  policy: IRedactionService | undefined,
  paths: readonly string[],
): IRedactionService {
  const legacy = createRedactionService(
    { fields: Object.fromEntries(paths.map((path) => [path, 'secret'])) },
    { caseSensitive: true },
  );
  return {
    redactValue(path: string, value: unknown): unknown {
      return legacy.redactValue(
        path,
        policy === undefined ? value : policy.redactValue(path, value),
      );
    },
    redactRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      return legacy.redactRecord(policy?.redactRecord(record) ?? record);
    },
  };
}

/**
 * Builds `RequestLoggerOptions` without ever assigning `undefined` to an
 * optional property (required by `exactOptionalPropertyTypes`).
 *
 * @param options - Source plugin options
 * @returns Options for the request-logger middleware
 */
function buildRequestLoggerOptions(options?: LoggerPluginOptions): RequestLoggerOptions {
  const base: {
    slowRequestThreshold?: number;
    excludePaths?: readonly string[];
  } = {};
  if (options?.slowRequestThreshold !== undefined) {
    base.slowRequestThreshold = options.slowRequestThreshold;
  }
  if (options?.excludePaths !== undefined) {
    base.excludePaths = options.excludePaths;
  }
  return base;
}

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
  IRuntimeServices,
  LogLevel,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { ConsoleLogger } from '../loggers/console-logger.ts';
import { NoopLogger } from '../loggers/noop-logger.ts';
import { PinoLogger } from '../loggers/pino-logger.ts';
import type { PinoFactory, PinoLoggerOptions } from '../loggers/pino-logger.ts';
import { createRequestLoggerMiddleware } from '../middleware/request-logger.ts';
import type { RequestLoggerOptions } from '../middleware/request-logger.ts';

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
 * import { LoggerPlugin } from '@hono-enterprise/logger-plugin';
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

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    dependencies: ['runtime'],
    provides: [CAPABILITIES.LOGGER],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const logger = await createLogger(transport, level, runtime, options);

      ctx.services.register<ILogger>(CAPABILITIES.LOGGER, logger);

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
): Promise<ILogger> {
  switch (transport) {
    case 'noop':
      return new NoopLogger({ level });
    case 'pino':
      return await PinoLogger.create(buildPinoLoggerOptions(level, options));
    case 'console':
    default:
      return new ConsoleLogger(runtime, buildConsoleOptions(level, options));
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
): PinoLoggerOptions {
  const base: {
    level: LogLevel;
    redact?: readonly string[];
    pinoFactory?: PinoFactory;
  } = { level };
  if (options?.redact !== undefined) {
    base.redact = options.redact;
  }
  if (options?.pinoFactory !== undefined) {
    base.pinoFactory = options.pinoFactory;
  }
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
): { level: LogLevel; pretty?: boolean; redact?: readonly string[] } {
  const base: { level: LogLevel; pretty?: boolean; redact?: readonly string[] } = { level };
  if (options?.pretty !== undefined) {
    base.pretty = options.pretty;
  }
  if (options?.redact !== undefined) {
    base.redact = options.redact;
  }
  return base;
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

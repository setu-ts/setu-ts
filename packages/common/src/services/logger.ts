/**
 * Logging contract, fulfilled by the LoggerPlugin under
 * `CAPABILITIES.LOGGER`.
 *
 * @module
 */
import type { LogLevel } from '../types.ts';

/**
 * Structured metadata attached to a log entry.
 *
 * @since 0.1.0
 */
export type LogMetadata = Readonly<Record<string, unknown>>;

/**
 * Structured logger. All framework and application logging goes through
 * this interface — never `console` (AI_GUIDELINES §11.6).
 *
 * @example
 * ```typescript
 * const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
 * logger.info('User created', { userId: user.id });
 *
 * const requestLogger = logger.child({ requestId: ctx.id });
 * ```
 * @since 0.1.0
 */
export interface ILogger {
  /** The minimum level this logger emits. */
  readonly level: LogLevel;
  /**
   * Logs at `fatal` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  fatal(message: string, metadata?: LogMetadata): void;
  /**
   * Logs at `error` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  error(message: string, metadata?: LogMetadata): void;
  /**
   * Logs at `warn` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  warn(message: string, metadata?: LogMetadata): void;
  /**
   * Logs at `info` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  info(message: string, metadata?: LogMetadata): void;
  /**
   * Logs at `debug` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  debug(message: string, metadata?: LogMetadata): void;
  /**
   * Logs at `trace` severity.
   *
   * @param message - Log message
   * @param metadata - Structured context
   */
  trace(message: string, metadata?: LogMetadata): void;
  /**
   * Creates a child logger whose entries always include the bindings.
   *
   * @param bindings - Metadata merged into every entry
   * @returns The child logger
   */
  child(bindings: LogMetadata): ILogger;
}

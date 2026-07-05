/**
 * No-op logger — discards all output. Useful for tests and for disabling
 * logging entirely without changing application code.
 *
 * @module
 */
import type { ILogger, LogMetadata } from '@hono-enterprise/common';
import type { LogLevel } from '@hono-enterprise/common';

/**
 * Options for constructing a {@linkcode NoopLogger}. Currently unused but
 * kept for a stable, forward-compatible constructor signature that mirrors
 * the other logger implementations.
 *
 * @since 0.1.0
 */
export interface NoopLoggerOptions {
  /** Accepted for API symmetry; ignored. */
  readonly level?: LogLevel;
  /** Accepted for API symmetry; ignored. */
  readonly bindings?: LogMetadata;
}

/**
 * Logger that does nothing. Every method is a no-op and `child()` returns
 * the same instance, so it is cheap to share widely.
 *
 * @example
 * ```typescript
 * const logger = new NoopLogger();
 * logger.info('ignored'); // no output
 * logger.child({ requestId: 'x' }) === logger; // true
 * ```
 * @since 0.1.0
 */
export class NoopLogger implements ILogger {
  /** The configured level; defaults to `trace`. No output is ever produced. */
  readonly level: LogLevel;

  /**
   * @param options - Optional level and bindings; level is stored for introspection.
   */
  constructor(options?: NoopLoggerOptions) {
    this.level = options?.level ?? 'trace';
  }

  /** @inheritdoc */
  fatal(_message: string, _metadata?: LogMetadata): void {}

  /** @inheritdoc */
  error(_message: string, _metadata?: LogMetadata): void {}

  /** @inheritdoc */
  warn(_message: string, _metadata?: LogMetadata): void {}

  /** @inheritdoc */
  info(_message: string, _metadata?: LogMetadata): void {}

  /** @inheritdoc */
  debug(_message: string, _metadata?: LogMetadata): void {}

  /** @inheritdoc */
  trace(_message: string, _metadata?: LogMetadata): void {}

  /**
   * Returns this same instance — a no-op logger has no state to fork.
   *
   * @returns This logger.
   */
  child(_bindings: LogMetadata): ILogger {
    return this;
  }
}

/** Internal adapter applying framework logging policy before a custom sink. */
import type { ILogger, IRedactionService, LogLevel, LogMetadata } from '@setu-ts/common';
import { normalizeMetadata } from './normalize-metadata.ts';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
});

/**
 * Keeps filtering and redaction on every child returned by the application's logger.
 * @since 0.11.0
 */
export class CustomLogger implements ILogger {
  readonly level: LogLevel;
  readonly #inner: ILogger;
  readonly #redaction: IRedactionService;

  constructor(inner: ILogger, level: LogLevel, redaction: IRedactionService) {
    this.#inner = inner;
    this.level = level;
    this.#redaction = redaction;
  }

  fatal(message: string, metadata?: LogMetadata): void {
    this.#log('fatal', message, metadata);
  }
  error(message: string, metadata?: LogMetadata): void {
    this.#log('error', message, metadata);
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.#log('warn', message, metadata);
  }
  info(message: string, metadata?: LogMetadata): void {
    this.#log('info', message, metadata);
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.#log('debug', message, metadata);
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.#log('trace', message, metadata);
  }

  child(bindings: LogMetadata): ILogger {
    return new CustomLogger(
      this.#inner.child(this.#redaction.redactRecord(normalizeMetadata(bindings))),
      this.level,
      this.#redaction,
    );
  }

  #log(level: LogLevel, message: string, metadata?: LogMetadata): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    this.#inner[level](
      message,
      metadata === undefined
        ? undefined
        : this.#redaction.redactRecord(normalizeMetadata(metadata)),
    );
  }
}

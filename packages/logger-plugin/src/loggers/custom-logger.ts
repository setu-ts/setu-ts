/** Internal adapter applying framework logging policy before a custom sink. */
import type { ILogger, IRedactionService, LogLevel, LogMetadata } from '@setu-ts/common';
import { normalizeMetadata, UNSERIALIZABLE_METADATA } from './normalize-metadata.ts';

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

  /**
   * Never throws. Bindings that throw while being read are dropped; a sink whose
   * `child()` throws is kept as is, without the new bindings, so redaction and
   * level filtering still wrap every record.
   */
  child(bindings: LogMetadata): ILogger {
    let redacted: Readonly<Record<string, unknown>>;
    try {
      redacted = this.#redaction.redactRecord(normalizeMetadata(bindings));
    } catch {
      redacted = {};
    }
    let inner: ILogger;
    try {
      inner = this.#inner.child(redacted);
    } catch {
      inner = this.#inner;
    }
    return new CustomLogger(inner, this.level, this.#redaction);
  }

  /**
   * Never throws, matching the console transport: a log call sits on request
   * paths, so a fault here must not become the request's fault. Metadata that
   * throws while being read is replaced by {@linkcode UNSERIALIZABLE_METADATA};
   * a sink that throws loses the record, since there is nowhere left to report it.
   */
  #log(level: LogLevel, message: string, metadata?: LogMetadata): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    let payload: Readonly<Record<string, unknown>> | undefined;
    try {
      payload =
        metadata === undefined
          ? undefined
          : this.#redaction.redactRecord(normalizeMetadata(metadata));
    } catch {
      payload = { metadata: UNSERIALIZABLE_METADATA };
    }
    try {
      this.#inner[level](message, payload);
    } catch {
      // The application's sink failed; the caller must not.
    }
  }
}

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

/** Shared by a root logger and all its children, so a broken sink is reported once. */
interface SinkFailureReport {
  reported: boolean;
}

/**
 * Keeps filtering and redaction on every child returned by the application's logger.
 * @since 0.11.0
 */
export class CustomLogger implements ILogger {
  readonly level: LogLevel;
  readonly #inner: ILogger;
  readonly #redaction: IRedactionService;
  readonly #sinkFailure: SinkFailureReport;

  /**
   * @param inner - The application's sink
   * @param level - Minimum level forwarded to the sink
   * @param redaction - Applied to metadata and bindings before the sink sees them
   * @param sinkFailure - Internal: children share their root's report state
   */
  constructor(
    inner: ILogger,
    level: LogLevel,
    redaction: IRedactionService,
    sinkFailure: SinkFailureReport = { reported: false },
  ) {
    this.#inner = inner;
    this.level = level;
    this.#redaction = redaction;
    this.#sinkFailure = sinkFailure;
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
   * level filtering still wrap every record. A throwing sink is reported once
   * (once per root logger).
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
    } catch (error) {
      this.#reportSinkFailure(error);
      inner = this.#inner;
    }
    return new CustomLogger(inner, this.level, this.#redaction, this.#sinkFailure);
  }

  /**
   * Never throws, matching the console transport: a log call sits on request
   * paths, so a fault here must not become the request's fault. Metadata that
   * throws while being read is replaced by {@linkcode UNSERIALIZABLE_METADATA};
   * a sink that throws loses the record, and the first such failure is reported.
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
    } catch (error) {
      // The application's sink failed; the caller must not.
      this.#reportSinkFailure(error);
    }
  }

  /**
   * Writes ONE line to stderr the first time the sink throws, for this root and
   * all its children, naming only the error's class. The sink is the
   * application's only log output, so a silent drop would hide a broken logger
   * from every monitor; later failures stay silent, so a sink that is down
   * cannot flood stderr once per record.
   */
  #reportSinkFailure(error: unknown): void {
    if (this.#sinkFailure.reported) return;
    this.#sinkFailure.reported = true;
    try {
      // eslint-disable-next-line no-console -- the application's logger is the thing that failed
      console.error(
        `[@setu-ts/logger-plugin] custom logger sink threw ${errorName(error)}; records it rejects are dropped (reported once)`,
      );
    } catch {
      // stderr itself is unavailable; nothing further can report it.
    }
  }
}

/**
 * The thrown value's class name, and nothing else: stderr bypasses redaction,
 * and a sink's error message or cause chain is application data (a connection
 * string, the rejected record). Read guarded, and only an identifier is kept.
 */
function errorName(error: unknown): string {
  try {
    const raw: unknown = error instanceof Error ? error.name : typeof error;
    // Only a primitive string, never coerced: a `toString` could answer the
    // check with one value and the template literal with another.
    return typeof raw === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(raw) ? raw : 'Error';
  } catch {
    return 'an unreadable value';
  }
}

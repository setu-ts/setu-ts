// deno-lint-ignore-file no-console
// ConsoleLogger is the sanctioned logger implementation (AI_GUIDELINES §11.6).
/**
 * Console-backed structured logger — runtime-independent JSON or pretty
 * output via the global `console`. The one place in the framework where
 * `console` is permitted (AI_GUIDELINES §11.6).
 *
 * @module
 */
import { createRedactionService, eraseRedactor } from '@setu-ts/common';
import type {
  ILogger,
  IRedactionService,
  IRuntimeServices,
  LogLevel,
  LogMetadata,
} from '@setu-ts/common';

import { normalizeMetadata } from './normalize-metadata.ts';
import { safeStringify } from './safe-stringify.ts';

/**
 * Numeric severity ranking. Lower numbers are more severe (so a configured
 * level allows any entry whose rank is `<=` the configured rank).
 */
/**
 * Stands in for metadata that threw while being read. Emitted in place of the
 * metadata so the entry still reaches the operator and says why it is thin.
 */
const UNSERIALIZABLE_METADATA = '[unserializable metadata]';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
});

/**
 * Options for constructing a {@linkcode ConsoleLogger}.
 *
 * @since 0.1.0
 */
export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Defaults to `'info'`. */
  readonly level?: LogLevel;
  /** When `true`, pretty-print entries instead of emitting JSON lines. */
  readonly pretty?: boolean;
  /** Dot-paths to redact from metadata (e.g. `['password', 'auth.token']`). */
  readonly redact?: readonly string[];
  /** Optional policy service applied before the legacy `redact` paths. */
  readonly redaction?: IRedactionService;
  /** Bindings merged into every entry produced by this logger. */
  readonly bindings?: LogMetadata;
}

/**
 * Structured logger that writes JSON lines (or pretty text) to `console`.
 *
 * Runtime-independent: timestamps come from {@linkcode IRuntimeServices.now},
 * never from `Date.now()` directly.
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger(runtime, { level: 'debug', pretty: true });
 * logger.info('server started', { port: 3000 });
 * const child = logger.child({ requestId: 'abc' });
 * child.debug('handling request');
 * ```
 * @since 0.1.0
 */
export class ConsoleLogger implements ILogger {
  readonly level: LogLevel;
  readonly #runtime: IRuntimeServices;
  readonly #pretty: boolean;
  readonly #redact: readonly string[];
  readonly #legacyRedaction: IRedactionService;
  readonly #redaction: IRedactionService | undefined;
  readonly #bindings: LogMetadata;

  /**
   * @param runtime - Runtime services (for timestamps)
   * @param options - Configuration
   */
  constructor(runtime: IRuntimeServices, options?: ConsoleLoggerOptions) {
    this.#runtime = runtime;
    this.level = options?.level ?? 'info';
    this.#pretty = options?.pretty ?? false;
    this.#redact = options?.redact ?? [];
    this.#legacyRedaction = createRedactionService(
      {
        fields: Object.fromEntries(this.#redact.map((path) => [path, 'secret'])),
        redactors: { secret: eraseRedactor },
      },
      { caseSensitive: true },
    );
    this.#redaction = options?.redaction;
    this.#bindings = options?.bindings ?? {};
  }

  /** @inheritdoc */
  fatal(message: string, metadata?: LogMetadata): void {
    this.#log('fatal', message, metadata);
  }

  /** @inheritdoc */
  error(message: string, metadata?: LogMetadata): void {
    this.#log('error', message, metadata);
  }

  /** @inheritdoc */
  warn(message: string, metadata?: LogMetadata): void {
    this.#log('warn', message, metadata);
  }

  /** @inheritdoc */
  info(message: string, metadata?: LogMetadata): void {
    this.#log('info', message, metadata);
  }

  /** @inheritdoc */
  debug(message: string, metadata?: LogMetadata): void {
    this.#log('debug', message, metadata);
  }

  /** @inheritdoc */
  trace(message: string, metadata?: LogMetadata): void {
    this.#log('trace', message, metadata);
  }

  /**
   * Returns a new logger whose entries always include `bindings` merged on
   * top of this logger's existing bindings.
   *
   * @param bindings - Metadata merged into every child entry
   * @returns A new child logger
   */
  child(bindings: LogMetadata): ILogger {
    const childOptions = {
      level: this.level,
      pretty: this.#pretty,
      redact: this.#redact,
      bindings: { ...this.#bindings, ...bindings },
    };
    return new ConsoleLogger(
      this.#runtime,
      this.#redaction === undefined
        ? childOptions
        : { ...childOptions, redaction: this.#redaction },
    );
  }

  /**
   * Emits a single entry if its level is at or above the configured level.
   *
   * @param level - Severity of the entry
   * @param message - Log message
   * @param metadata - Structured context
   */
  #log(level: LogLevel, message: string, metadata?: LogMetadata): void {
    // Lower rank = more severe. Emit only entries whose rank is >= the
    // configured level's rank (i.e. at or above the configured severity).
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) {
      return;
    }
    // Everything that READS the caller's metadata is inside this guard, not
    // just serialization. An own enumerable getter fires during the spread
    // below — before `normalizeMetadata`, before redaction and before
    // `safeStringify` can see the value at all — so guarding the serializer
    // alone would still let the throw escape from the first line that touches
    // the object. `normalizeMetadata` and `#redactFields` read properties too.
    try {
      const merged: Record<string, unknown> = {
        ...this.#bindings,
        ...metadata,
      };
      // Normalize raw `Error` values BEFORE redaction (X2-5): a redact path
      // such as `error.token` must see the normalized object, and an
      // un-normalized `Error` would otherwise reach `JSON.stringify` and
      // render as `{}`.
      const normalized = normalizeMetadata(merged);
      const policyRedacted = this.#redaction?.redactRecord(normalized) ?? normalized;
      const redacted = this.#legacyRedaction.redactRecord(policyRedacted);
      if (this.#pretty) {
        this.#prettyPrint(level, message, redacted);
      } else {
        const entry = {
          level,
          time: this.#runtime.now(),
          msg: message,
          ...redacted,
        };
        // The entry is emitted WITHOUT its metadata rather than lost, because
        // the level, time and message are usually the half an operator is
        // looking for and are always serializable.
        console.log(safeStringify(entry) ?? this.#unserializableLine(level, message));
      }
    } catch {
      this.#emitUnserializable(level, message);
    }
  }

  /**
   * Emits an entry whose metadata could not be read or serialized at all.
   *
   * Reached only when the caller's own code threw while its metadata was being
   * read. Every value used here is a primitive this class produced, so it
   * cannot fail for the reason the entry it replaces did — which is what makes
   * "a log call emits exactly one line and never throws" true rather than
   * merely intended.
   *
   * @param level - Severity of the entry
   * @param message - Log message
   */
  #emitUnserializable(level: LogLevel, message: string): void {
    if (this.#pretty) {
      const ts = new Date(this.#runtime.now()).toISOString();
      console.log(`${ts} [${level.toUpperCase()}] ${message} ${UNSERIALIZABLE_METADATA}`);
    } else {
      console.log(this.#unserializableLine(level, message));
    }
  }

  /**
   * Pretty-prints a log entry to `console` with a human-readable prefix.
   *
   * @param level - Severity
   * @param message - Log message
   * @param metadata - Structured context
   */
  /**
   * Builds the JSON line used when an entry's metadata could not be serialized.
   *
   * Every field here is a primitive this class produced, so this cannot fail
   * for the reason the entry it replaces did.
   *
   * @param level - Severity of the entry
   * @param message - Log message
   * @returns A JSON line carrying the entry minus its metadata
   */
  #unserializableLine(level: LogLevel, message: string): string {
    return JSON.stringify({
      level,
      time: this.#runtime.now(),
      msg: message,
      metadata: UNSERIALIZABLE_METADATA,
    });
  }

  #prettyPrint(level: LogLevel, message: string, metadata: Record<string, unknown>): void {
    const ts = new Date(this.#runtime.now()).toISOString();
    const meta = Object.keys(metadata).length > 0
      ? ` ${safeStringify(metadata) ?? UNSERIALIZABLE_METADATA}`
      : '';
    console.log(`${ts} [${level.toUpperCase()}] ${message}${meta}`);
  }
}

// deno-lint-ignore-file no-console
// ConsoleLogger is the sanctioned logger implementation (AI_GUIDELINES §11.6).
/**
 * Console-backed structured logger — runtime-independent JSON or pretty
 * output via the global `console`. The one place in the framework where
 * `console` is permitted (AI_GUIDELINES §11.6).
 *
 * @module
 */
import type { ILogger, IRuntimeServices, LogLevel, LogMetadata } from '@hono-enterprise/common';

/**
 * Numeric severity ranking. Lower numbers are more severe (so a configured
 * level allows any entry whose rank is `<=` the configured rank).
 */
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
    return new ConsoleLogger(this.#runtime, {
      level: this.level,
      pretty: this.#pretty,
      redact: this.#redact,
      bindings: { ...this.#bindings, ...bindings },
    });
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
    const merged: Record<string, unknown> = {
      ...this.#bindings,
      ...metadata,
    };
    const redacted = this.#redactFields(merged);
    const entry = {
      level,
      time: this.#runtime.now(),
      msg: message,
      ...redacted,
    };
    if (this.#pretty) {
      this.#prettyPrint(level, message, redacted);
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  /**
   * Returns a shallow-cloned record with redacted paths replaced by
   * `'[Redacted]'`. Supports dot-paths into nested objects.
   *
   * @param data - The record to redact
   * @returns A redacted copy
   */
  #redactFields(data: Record<string, unknown>): Record<string, unknown> {
    if (this.#redact.length === 0) {
      return data;
    }
    const clone: Record<string, unknown> = { ...data };
    for (const path of this.#redact) {
      this.#redactPath(clone, path);
    }
    return clone;
  }

  /**
   * Redacts a single dot-path within `target`, mutating it in place.
   *
   * @param target - The record to mutate
   * @param path - Dot-separated path (e.g. `'auth.token'`)
   */
  #redactPath(target: Record<string, unknown>, path: string): void {
    const segments = path.split('.');
    let current: Record<string, unknown> = target;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      const next = current[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        return;
      }
      current = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    if (leaf in current) {
      current[leaf] = '[Redacted]';
    }
  }

  /**
   * Pretty-prints a log entry to `console` with a human-readable prefix.
   *
   * @param level - Severity
   * @param message - Log message
   * @param metadata - Structured context
   */
  #prettyPrint(level: LogLevel, message: string, metadata: Record<string, unknown>): void {
    const ts = new Date(this.#runtime.now()).toISOString();
    const meta = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : '';
    console.log(`${ts} [${level.toUpperCase()}] ${message}${meta}`);
  }
}

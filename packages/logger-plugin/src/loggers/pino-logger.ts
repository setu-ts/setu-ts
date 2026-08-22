/**
 * Pino-backed structured logger. Pino is an optional dependency — it is
 * loaded via a real `import('npm:pino@10.x')` when the async factory
 * {@linkcode PinoLogger.create} is used, or can be injected through the
 * `pinoFactory` option for tests and pre-loaded clients.
 *
 * Applications that use the `console` or `noop` transports never load Pino.
 *
 * @module
 */
import type { ILogger, LogLevel, LogMetadata } from '@setu-ts/common';

import { normalizeMetadata } from './normalize-metadata.ts';

/**
 * Minimal structural shape of a Pino logger that this wrapper depends on.
 * Declared locally so we do not import Pino's types at module load time.
 *
 * @since 0.1.0
 */
interface PinoLoggerLike {
  readonly level: string;
  // Pino's real signature is (obj, msg) — the structured object FIRST, the
  // message second. Calling it as (msg, obj) silently drops the object (verified
  // against real pino, M70f §8), so the wrapper passes metadata first.
  fatal(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  info(obj: unknown, msg: string): void;
  debug(obj: unknown, msg: string): void;
  trace(obj: unknown, msg: string): void;
  child(bindings: LogMetadata): PinoLoggerLike;
}

/**
 * Factory signature for creating a Pino logger instance. Matches the shape
 * of the `pino` default export and allows tests to inject a stub.
 *
 * @since 0.1.0
 */
export type PinoFactory = (options: {
  level: LogLevel;
  redact?: readonly string[];
  base?: Record<string, unknown>;
}) => PinoLoggerLike;

/**
 * Normalizes the shape of the dynamically-imported `pino` module to a callable
 * {@linkcode PinoFactory}. Handles an ESM default export (`mod.default`), a
 * directly-callable module (CJS interop), and a namespace object without a default.
 * Exported for unit testing; intentionally NOT re-exported from `index.ts`, so it is
 * not public API (AI_GUIDELINES §10.1).
 *
 * @param mod - The imported module namespace or callable
 * @returns The Pino factory function
 * @since 0.1.0
 */
export function normalizePinoFactory(mod: unknown): PinoFactory {
  if (typeof mod === 'function') {
    return mod as PinoFactory;
  }
  const ns = mod as { default?: PinoFactory };
  return ns.default ?? (mod as PinoFactory);
}

/**
 * Options for constructing a {@linkcode PinoLogger}.
 *
 * @since 0.1.0
 */
export interface PinoLoggerOptions {
  /** Minimum level to emit. Defaults to `'info'`. */
  readonly level?: LogLevel;
  /** Dot-paths to redact from metadata, delegated to Pino's built-in redaction. */
  readonly redact?: readonly string[];
  /** Bindings merged into every entry produced by this logger. */
  readonly bindings?: LogMetadata;
  /**
   * Inject a pre-loaded Pino factory, bypassing the `import('npm:pino@10.x')`
   * path. Useful for tests and environments where the module is already
   * available in-memory.
   *
   * @since 0.1.0
   */
  readonly pinoFactory?: PinoFactory;
}

/**
 * Structured logger backed by [Pino](https://github.com/pinojs/pino).
 *
 * Because the `npm:pino` import is async, use {@linkcode PinoLogger.create}
 * (async factory) rather than `new`. An injected `pinoFactory` option
 * allows synchronous construction for tests.
 *
 * @example Async construction (real Pino)
 * ```typescript
 * const logger = await PinoLogger.create({ level: 'debug', redact: ['password'] });
 * logger.info('server started', { port: 3000 });
 * ```
 *
 * @example Injected factory (tests)
 * ```typescript
 * const logger = await PinoLogger.create({
 *   level: 'info',
 *   pinoFactory: (opts) => fakePino,
 * });
 * ```
 * @since 0.1.0
 */
export class PinoLogger implements ILogger {
  readonly level: LogLevel;
  readonly #pino: PinoLoggerLike;

  /**
   * @internal Use {@linkcode PinoLogger.create} instead. Exists so
   * {@linkcode PinoLogger.child} can return `ILogger` instances.
   *
   * @param level - Minimum log level
   * @param pino - Pre-constructed Pino instance
   */
  constructor(level: LogLevel, pino: PinoLoggerLike) {
    this.level = level;
    this.#pino = pino;
  }

  /**
   * Asynchronously creates a {@linkcode PinoLogger}.
   *
   * When `pinoFactory` is provided in options, the factory is called
   * synchronously and no import is performed. Otherwise, Pino is loaded
   * via `await import('npm:pino@10.x')`.
   *
   * @param options - Configuration
   * @returns A new PinoLogger instance
   * @throws {Error} If Pino cannot be loaded from `npm:pino` and no
   *   `pinoFactory` was injected.
   */
  static async create(options: PinoLoggerOptions = {}): Promise<PinoLogger> {
    const level = options.level ?? 'info';
    let factory = options.pinoFactory;
    if (factory === undefined) {
      factory = await PinoLogger.#loadPino();
    }
    const pino = PinoLogger.#buildPino(level, factory, options);
    return new PinoLogger(level, pino);
  }

  /** @inheritdoc */
  fatal(message: string, metadata?: LogMetadata): void {
    this.#pino.fatal(normalize(metadata), message);
  }

  /** @inheritdoc */
  error(message: string, metadata?: LogMetadata): void {
    this.#pino.error(normalize(metadata), message);
  }

  /** @inheritdoc */
  warn(message: string, metadata?: LogMetadata): void {
    this.#pino.warn(normalize(metadata), message);
  }

  /** @inheritdoc */
  info(message: string, metadata?: LogMetadata): void {
    this.#pino.info(normalize(metadata), message);
  }

  /** @inheritdoc */
  debug(message: string, metadata?: LogMetadata): void {
    this.#pino.debug(normalize(metadata), message);
  }

  /** @inheritdoc */
  trace(message: string, metadata?: LogMetadata): void {
    this.#pino.trace(normalize(metadata), message);
  }

  /**
   * Returns a child logger backed by Pino's native `child()`.
   *
   * @param bindings - Metadata merged into every child entry
   * @returns A new child logger
   */
  child(bindings: LogMetadata): ILogger {
    // Normalize before hand-off so an Error-valued binding survives Pino's
    // serialization instead of collapsing to {} (X2-5, M70f re-review finding 1).
    const childPino = this.#pino.child(normalizeMetadata(bindings));
    return new PinoLoggerAdapter(this.level, childPino);
  }

  /**
   * Builds a Pino logger instance from the given factory and options.
   *
   * @param level - Minimum log level
   * @param factory - The Pino factory function
   * @param options - Redaction paths and base bindings
   * @returns A Pino logger instance
   */
  static #buildPino(
    level: LogLevel,
    factory: PinoFactory,
    options?: PinoLoggerOptions,
  ): PinoLoggerLike {
    const pinoOptions: {
      level: LogLevel;
      redact?: readonly string[];
      base?: Record<string, unknown>;
    } = { level };
    if (options?.redact !== undefined) {
      pinoOptions.redact = options.redact;
    }
    if (options?.bindings !== undefined) {
      // Normalize the base bindings too, so an Error supplied as a base binding
      // is preserved in every emitted record rather than flattened to {} (X2-5,
      // M70f re-review finding 1).
      pinoOptions.base = normalizeMetadata(options.bindings);
    }
    return factory(pinoOptions);
  }

  /**
   * Loads the real Pino module lazily via `import('npm:pino@10.x')`. Wraps import
   * failures in a clear error message.
   *
   * @returns The Pino factory function
   * @throws {Error} If Pino cannot be imported
   */
  static async #loadPino(): Promise<PinoFactory> {
    try {
      // pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      const mod = await import('npm:pino@10.x');
      return normalizePinoFactory(mod);
    } catch {
      throw new Error(
        'PinoLogger requires Pino. Install it (deno add npm:pino) or use the console transport.',
      );
    }
  }
}

/**
 * Internal adapter that wraps an already-created Pino logger (e.g. the
 * result of `child()`) so it conforms to {@linkcode ILogger} without
 * re-importing Pino.
 *
 * @since 0.1.0
 */
class PinoLoggerAdapter implements ILogger {
  readonly level: LogLevel;
  readonly #pino: PinoLoggerLike;

  constructor(level: LogLevel, pino: PinoLoggerLike) {
    this.level = level;
    this.#pino = pino;
  }

  fatal(message: string, metadata?: LogMetadata): void {
    this.#pino.fatal(normalize(metadata), message);
  }
  error(message: string, metadata?: LogMetadata): void {
    this.#pino.error(normalize(metadata), message);
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.#pino.warn(normalize(metadata), message);
  }
  info(message: string, metadata?: LogMetadata): void {
    this.#pino.info(normalize(metadata), message);
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.#pino.debug(normalize(metadata), message);
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.#pino.trace(normalize(metadata), message);
  }
  child(bindings: LogMetadata): ILogger {
    // Normalize before hand-off so an Error-valued binding survives Pino's
    // serialization instead of collapsing to {} (X2-5, M70f re-review finding 1).
    return new PinoLoggerAdapter(this.level, this.#pino.child(normalizeMetadata(bindings)));
  }
}

/**
 * Normalizes log metadata for hand-off to Pino: a raw `Error` is replaced by
 * its serializable form (X2-5) and the result is passed as Pino's first
 * (object) argument. `undefined` metadata stays `undefined`, so a message-only
 * log emits no empty object.
 *
 * @param metadata - The caller's metadata
 * @returns The normalized object, or `undefined`
 */
function normalize(metadata: LogMetadata | undefined): unknown {
  return metadata !== undefined ? normalizeMetadata(metadata) : undefined;
}

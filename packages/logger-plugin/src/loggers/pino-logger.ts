/**
 * Pino-backed structured logger. Pino is an optional dependency — it is
 * loaded via a real `import('npm:pino')` when the async factory
 * {@linkcode PinoLogger.create} is used, or can be injected through the
 * `pinoFactory` option for tests and pre-loaded clients.
 *
 * Applications that use the `console` or `noop` transports never load Pino.
 *
 * @module
 */
import type { ILogger, LogLevel, LogMetadata } from '@hono-enterprise/common';

/**
 * Minimal structural shape of a Pino logger that this wrapper depends on.
 * Declared locally so we do not import Pino's types at module load time.
 *
 * @since 0.1.0
 */
interface PinoLoggerLike {
  readonly level: string;
  fatal(msg: string, metadata?: LogMetadata): void;
  error(msg: string, metadata?: LogMetadata): void;
  warn(msg: string, metadata?: LogMetadata): void;
  info(msg: string, metadata?: LogMetadata): void;
  debug(msg: string, metadata?: LogMetadata): void;
  trace(msg: string, metadata?: LogMetadata): void;
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
   * Inject a pre-loaded Pino factory, bypassing the `import('npm:pino')`
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
   * via `await import('npm:pino')`.
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
    this.#pino.fatal(message, metadata);
  }

  /** @inheritdoc */
  error(message: string, metadata?: LogMetadata): void {
    this.#pino.error(message, metadata);
  }

  /** @inheritdoc */
  warn(message: string, metadata?: LogMetadata): void {
    this.#pino.warn(message, metadata);
  }

  /** @inheritdoc */
  info(message: string, metadata?: LogMetadata): void {
    this.#pino.info(message, metadata);
  }

  /** @inheritdoc */
  debug(message: string, metadata?: LogMetadata): void {
    this.#pino.debug(message, metadata);
  }

  /** @inheritdoc */
  trace(message: string, metadata?: LogMetadata): void {
    this.#pino.trace(message, metadata);
  }

  /**
   * Returns a child logger backed by Pino's native `child()`.
   *
   * @param bindings - Metadata merged into every child entry
   * @returns A new child logger
   */
  child(bindings: LogMetadata): ILogger {
    const childPino = this.#pino.child(bindings);
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
      pinoOptions.base = options.bindings as Record<string, unknown>;
    }
    return factory(pinoOptions);
  }

  /**
   * Loads the real Pino module lazily via `import('npm:pino')`. Wraps import
   * failures in a clear error message.
   *
   * @returns The Pino factory function
   * @throws {Error} If Pino cannot be imported
   */
  static async #loadPino(): Promise<PinoFactory> {
    try {
      // deno-lint-ignore no-unversioned-import -- pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      const mod = await import('npm:pino');
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
    this.#pino.fatal(message, metadata);
  }
  error(message: string, metadata?: LogMetadata): void {
    this.#pino.error(message, metadata);
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.#pino.warn(message, metadata);
  }
  info(message: string, metadata?: LogMetadata): void {
    this.#pino.info(message, metadata);
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.#pino.debug(message, metadata);
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.#pino.trace(message, metadata);
  }
  child(bindings: LogMetadata): ILogger {
    return new PinoLoggerAdapter(this.level, this.#pino.child(bindings));
  }
}

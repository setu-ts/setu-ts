/**
 * Routes a backend client's connection-error events to the logger.
 *
 * @module
 *
 * A driver that owns a socket usually reports connection failures as events
 * rather than as rejections: `ioredis` emits `'error'` on every failed
 * reconnect attempt, and with no listener attached it writes each one to
 * `console.error` itself. That output skips the application's logger entirely
 * — no structure, no redaction, no sink — and repeats on every retry, so one
 * outage can print dozens of lines. No lint rule can see it, because the
 * console call lives inside the dependency.
 *
 * This module is the one implementation every package that builds such a
 * client attaches through. It reports the FIRST error of a run at `warn`,
 * consecutive repeats of the same message at `debug` with a running count, and
 * the recovery at `info` — so an outage is one warning, not fifty, and its end
 * is visible. It is a log channel only: whether the backend is reachable is
 * still answered by each package's `isHealthy` probe, which this does not touch.
 *
 * @since 0.8.0
 */
import type { ILogger } from '../services/logger.ts';

/**
 * The logger surface the reporter writes to.
 *
 * @since 0.8.0
 */
export type ConnectionErrorLogger = Pick<ILogger, 'warn' | 'info' | 'debug'>;

/**
 * Options for {@linkcode createConnectionErrorReporter}.
 *
 * @since 0.8.0
 */
export interface ConnectionErrorReporterOptions {
  /**
   * Names the connection in every line, for example
   * `'cache-plugin: redis store'`. Written into the message and as the
   * `source` metadata field.
   */
  readonly source: string;
  /**
   * Returns the logger to write to, read at the moment an event arrives rather
   * than when the reporter is built — a logger registered after the client was
   * built is still honoured. Returning `undefined` drops the event: the
   * application registered no log sink, and the owning package's health probe
   * still reports the outage.
   */
  readonly logger: () => ConnectionErrorLogger | undefined;
}

/**
 * De-duplicating sink for one connection's error events.
 *
 * Neither method throws, whatever the logger or the reported value does: both
 * are invoked from an event-emitter listener, where a throw is an uncaught
 * exception.
 *
 * @since 0.8.0
 */
export interface ConnectionErrorReporter {
  /**
   * Reports one connection error. The first error of a run, or one whose
   * message differs from the previous error, logs at `warn`; a repeat of the
   * previous message logs at `debug` with a `repeats` count.
   *
   * @param error - The emitted error (any value; only its message is logged)
   */
  report(error: unknown): void;
  /**
   * Marks the connection usable again. When at least one error was reported
   * since the last recovery, logs once at `info` and resets, so the next
   * outage warns again. A no-op otherwise.
   */
  recovered(): void;
}

/** Extracts a loggable message without letting a hostile value throw. */
function messageOf(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  } catch {
    return 'unrepresentable error value';
  }
}

/**
 * Builds a reporter for one connection (or one set of connections that fail
 * together, such as a publisher/subscriber pair).
 *
 * @param options - The source label and a call-time logger accessor
 * @returns A reporter whose methods never throw
 * @example
 * ```typescript
 * const reporter = createConnectionErrorReporter({
 *   source: 'my-plugin: redis',
 *   logger: () => ctx.logger,
 * });
 * attachConnectionErrorReporter(client, reporter);
 * ```
 * @since 0.8.0
 */
export function createConnectionErrorReporter(
  options: ConnectionErrorReporterOptions,
): ConnectionErrorReporter {
  const { source } = options;
  let last: string | undefined;
  let repeats = 0;
  let total = 0;

  const write = (action: (logger: ConnectionErrorLogger) => void): void => {
    try {
      const logger = options.logger();
      if (logger !== undefined) {
        action(logger);
      }
    } catch {
      // A failing log sink must never become an uncaught exception inside the
      // driver's event emitter; the event is dropped instead.
    }
  };

  return {
    report(error: unknown): void {
      const message = messageOf(error);
      total++;
      if (message === last) {
        repeats++;
        const count = repeats;
        write((logger) =>
          logger.debug(`${source}: connection error repeated: ${message}`, {
            source,
            error: message,
            repeats: count,
          })
        );
        return;
      }
      last = message;
      repeats = 0;
      write((logger) =>
        logger.warn(`${source}: connection error: ${message}`, { source, error: message })
      );
    },
    recovered(): void {
      if (total === 0) {
        return;
      }
      const errors = total;
      last = undefined;
      repeats = 0;
      total = 0;
      write((logger) =>
        logger.info(`${source}: connection recovered after ${errors} error(s)`, {
          source,
          errors,
        })
      );
    },
  };
}

/** The event-emitter surface {@linkcode attachConnectionErrorReporter} uses. */
interface ErrorEventSource {
  on(event: string, listener: (value: unknown) => void): unknown;
}

/**
 * Attaches a reporter to a client's `'error'` and `'ready'` events.
 *
 * Call it ONLY on a client the package built itself. An injected client
 * belongs to the caller, and adding an `'error'` listener to it would silence
 * the caller's own handling (`ioredis` falls back to the console only when no
 * listener exists). The client is checked structurally at runtime, so the
 * package's injection facade need not declare `on`.
 *
 * @param client - The built client; an object exposing an `on` method
 * @param reporter - The reporter to route events to
 * @returns `true` when the listeners were attached, `false` when the client
 * exposes no `on` method
 * @since 0.8.0
 */
export function attachConnectionErrorReporter(
  client: unknown,
  reporter: ConnectionErrorReporter,
): boolean {
  if (
    (typeof client !== 'object' && typeof client !== 'function') ||
    client === null ||
    typeof (client as { on?: unknown }).on !== 'function'
  ) {
    return false;
  }
  const source = client as ErrorEventSource;
  source.on('error', (error) => reporter.report(error));
  source.on('ready', () => reporter.recovered());
  return true;
}

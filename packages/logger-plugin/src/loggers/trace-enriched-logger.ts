/**
 * Internal decorator that joins a log record to the trace it was emitted in.
 *
 * Before this, `trace_id` appeared in `@setu-ts/common` and in
 * `@setu-ts/telemetry-plugin` and in no logger, formatter or transport: an
 * operator holding a trace id could not find the log lines, and one holding a
 * log line could not find the trace (X34-2). Every signal the framework emits
 * was individually good and mutually unjoinable.
 *
 * @module
 */

import type { ILogger, ITelemetryService, LogMetadata } from '@setu-ts/common';

/**
 * Resolves the telemetry capability, or reports `undefined` when none is
 * registered.
 *
 * A thunk rather than a resolved service, and that is structural rather than
 * cautious: `TelemetryPlugin` declares `CAPABILITIES.LOGGER` in its
 * `optionalDependencies`, so the kernel orders `LoggerPlugin` FIRST and
 * telemetry is guaranteed absent when the logger registers. Resolving eagerly
 * would enrich nothing, always. (Declaring the reverse edge is not the fix
 * either: the two together are a cycle the plugin resolver refuses at
 * `start()`.)
 *
 * @since 0.5.0
 */
export type TelemetryLookup = () => ITelemetryService | undefined;

/** The OTel log-correlation field naming the trace. */
const TRACE_ID_FIELD = 'trace_id';

/** The OTel log-correlation field naming the span. */
const SPAN_ID_FIELD = 'span_id';

/**
 * Wraps an {@linkcode ILogger} so every record carries the active span's
 * `trace_id` and `span_id` when a telemetry capability is registered.
 *
 * The fields are snake_case, departing from the framework's own camelCase
 * metadata convention (`requestId`), and the departure is the point: these
 * exist to be read by a log backend, and the OpenTelemetry log-correlation
 * convention — what Loki, Elastic and the collector's own processors key on —
 * is snake_case. A camelCase spelling would be internally consistent and would
 * join up in none of the tools the join exists for.
 *
 * A decorator rather than an edit to each logger: `ConsoleLogger` and
 * `PinoLogger` both hold `#` private fields, so enrichment has to call through
 * the instance rather than a detached method, and a decorator additionally
 * covers a custom `ILogger` an application registers under the capability.
 *
 * @internal
 */
export class TraceEnrichedLogger implements ILogger {
  /**
   * The decorated logger.
   *
   * Readable because this decorator REPLACES the concrete logger under
   * `CAPABILITIES.LOGGER`, so `instanceof ConsoleLogger` on the resolved
   * capability no longer holds; the chain has to stay inspectable for anything
   * that needs to know which transport was built. Not barrel-exported, so this
   * adds no public surface.
   */
  readonly inner: ILogger;
  readonly #telemetry: TelemetryLookup;

  /**
   * @param inner - The logger to decorate
   * @param telemetry - Resolves the telemetry capability at CALL time
   */
  constructor(inner: ILogger, telemetry: TelemetryLookup) {
    this.inner = inner;
    this.#telemetry = telemetry;
  }

  /** @inheritdoc */
  get level(): ILogger['level'] {
    return this.inner.level;
  }

  /** @inheritdoc */
  fatal(message: string, metadata?: LogMetadata): void {
    this.inner.fatal(message, this.#enrich(metadata));
  }

  /** @inheritdoc */
  error(message: string, metadata?: LogMetadata): void {
    this.inner.error(message, this.#enrich(metadata));
  }

  /** @inheritdoc */
  warn(message: string, metadata?: LogMetadata): void {
    this.inner.warn(message, this.#enrich(metadata));
  }

  /** @inheritdoc */
  info(message: string, metadata?: LogMetadata): void {
    this.inner.info(message, this.#enrich(metadata));
  }

  /** @inheritdoc */
  debug(message: string, metadata?: LogMetadata): void {
    this.inner.debug(message, this.#enrich(metadata));
  }

  /** @inheritdoc */
  trace(message: string, metadata?: LogMetadata): void {
    this.inner.trace(message, this.#enrich(metadata));
  }

  /**
   * Returns a DECORATED child, so bindings and enrichment compose.
   *
   * Load-bearing rather than tidy: the framework's own request logger builds
   * its per-request logger with `logger.child({ requestId: ctx.id })`, so a
   * child that lost the decorator would strip `trace_id` from precisely the
   * records X34-2 most wants joined — while every direct call on the parent
   * still enriched, and every unit test on this class still passed.
   *
   * @param bindings - Metadata merged into every child entry
   * @returns A decorated child logger
   */
  child(bindings: LogMetadata): ILogger {
    return new TraceEnrichedLogger(this.inner.child(bindings), this.#telemetry);
  }

  /**
   * Merges the active span's identifiers into a record's metadata.
   *
   * Guarded end to end. The telemetry capability is replaceable, so both the
   * lookup and the read can be arbitrary application code; a service that
   * throws must never turn the logging path into the fault, which would make
   * an observability fix an availability defect (M45b found exactly that class
   * in `worker-pool-plugin`). A failure enriches nothing and the record still
   * logs.
   *
   * The caller's own metadata wins on a key collision: an application that has
   * already put a `trace_id` on a record knows something this decorator does
   * not, and silently overwriting it would be the more surprising answer.
   *
   * @param metadata - The caller's metadata, if any
   * @returns The metadata with `trace_id`/`span_id` merged, or unchanged when
   * no span is active, no telemetry is registered, or the read failed
   */
  #enrich(metadata?: LogMetadata): LogMetadata | undefined {
    let context;
    try {
      context = this.#telemetry()?.activeSpanContext?.();
    } catch {
      // Deliberately swallowed and not reported: the only sink available here
      // is the very logger this call is decorating, so reporting would recurse
      // through the same failing read on every record.
      return metadata;
    }
    if (context === undefined) {
      return metadata;
    }
    return {
      [TRACE_ID_FIELD]: context.traceId,
      [SPAN_ID_FIELD]: context.spanId,
      ...metadata,
    };
  }
}

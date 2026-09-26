/**
 * Diagnostic span processor (M98g) — the additional OTel `SpanProcessor`
 * that feeds finished, sampled spans into the trace-observation collector.
 *
 * It is appended AFTER the configured exporter processor in the same
 * `BasicTracerProvider` constructor, so the exporter path is untouched: the
 * existing processor still receives every span first, and this one never
 * wraps it, never exports, and never throws into OTel. Against the locked
 * `@opentelemetry/sdk-trace` 2.x contract, `onStart` is a synchronous
 * no-op, the optional `onEnding` hook is omitted, `onEnd` is fully
 * synchronous and catches every failure, `forceFlush` returns an
 * already-resolved promise without touching the exporter, and `shutdown`
 * idempotently closes the collector.
 *
 * Minimization happens HERE, before anything is retained: `onEnd` reads
 * ONLY `name`, `kind`, `spanContext()`, `parentSpanContext`,
 * `links[].context`, `status.code` and `duration`. The span name is used
 * only for the exact allowlist lookup and is replaced by its approved alias
 * before buffering; attributes, events, resource labels, tracestate,
 * baggage, exception data, status messages and link attributes are
 * structurally unreachable — the projection cannot even express them.
 *
 * @module
 */
import type { TraceLinkRelationship, TraceOutcome } from '@setu-ts/common';
import type {
  CompiledTraceDiagnosticsPolicy,
  RetainedSpanCandidate,
} from './span-observation-collector.ts';
import { isSpanId, isTraceId } from './span-observation-collector.ts';
import type { SpanObservationCollector } from './span-observation-collector.ts';

/**
 * The maximum links one retained span carries — the fixed budget the
 * collector and the wire validator both enforce.
 *
 * @internal
 */
export const MAX_LINKS_PER_SPAN = 8;

/**
 * The minimal structural shape of the OTel readable span this processor
 * reads. Declared locally against the fields the design approves, so the
 * processor is unit-testable without the SDK and so NO other field is even
 * nameable here.
 *
 * @internal
 */
export interface ReadableSpanInput {
  /** The raw span name — used only for the allowlist lookup. */
  readonly name: string;
  /** The numeric OTel span kind. */
  readonly kind: number;
  /** The span's own context. */
  spanContext(): ReadableSpanContextInput;
  /** The parent context, when the span was created under one. */
  readonly parentSpanContext?: ReadableSpanContextInput;
  /** Links, each carrying only its context here. */
  readonly links?: readonly { readonly context: ReadableSpanContextInput }[];
  /** The span status; its message is never read. */
  readonly status?: { readonly code: number };
  /** The duration as an OTel hrtime tuple `[seconds, nanoseconds]`. */
  readonly duration?: readonly [number, number];
}

/** The minimal span-context shape the processor reads. */
export interface ReadableSpanContextInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags?: number;
  readonly isRemote?: boolean;
}

/**
 * Numeric OTel span kind → the framework's fixed vocabulary.
 *
 * The readable span carries the `@opentelemetry/api` `SpanKind` enum —
 * `INTERNAL = 0, SERVER = 1, CLIENT = 2, PRODUCER = 3, CONSUMER = 4`
 * (`api/build/esm/trace/span_kind.d.ts`), the numbering auto-instrumentation
 * and the framework's own `TelemetryService` both write. A span created
 * without an explicit kind arrives as `0` (measured against the locked SDK).
 * The OTLP WIRE enum is this plus one, and is never seen here. A value
 * outside the table drops the record rather than being improvised.
 *
 * @internal
 */
export const KIND_BY_OTEL_CODE: ReadonlyMap<number, RetainedSpanCandidate['kind']> = new Map([
  [0, 'internal'],
  [1, 'server'],
  [2, 'client'],
  [3, 'producer'],
  [4, 'consumer'],
]);

/**
 * Numeric OTel status code → the fixed outcome vocabulary.
 *
 * @internal
 */
export const OUTCOME_BY_OTEL_CODE: ReadonlyMap<number, TraceOutcome> = new Map([
  [0, 'unset'],
  [1, 'ok'],
  [2, 'error'],
]);

/**
 * The processor. Satisfies the locked 2.x `SpanProcessor` contract
 * (`onStart`/`onEnd`/`forceFlush`/`shutdown`; `onEnding` optional and
 * omitted).
 *
 * @internal
 */
export class DiagnosticSpanProcessor {
  readonly #policy: CompiledTraceDiagnosticsPolicy;
  readonly #collector: SpanObservationCollector;

  /**
   * Creates the processor over a compiled policy and the active collector.
   *
   * @param policy - The compiled trace-observation policy
   * @param collector - The collector the processor feeds
   */
  constructor(policy: CompiledTraceDiagnosticsPolicy, collector: SpanObservationCollector) {
    this.#policy = policy;
    this.#collector = collector;
  }

  /**
   * A synchronous no-op: the processor observes COMPLETIONS only, and a
   * started span holds nothing worth retaining.
   *
   * @param _span - The started span
   * @param _parentContext - The active context at start
   */
  onStart(_span: unknown, _parentContext: unknown): void {
    // Observes completions only — deliberately no state per started span.
  }

  /**
   * Minimizes one completed span and hands the candidate to the collector.
   * NEVER throws: any failure — a hostile getter, an unmappable kind or
   * status, an invalid identifier — is one saturating drop, so a broken span
   * can never disrupt the exporter pipeline that shares this provider.
   *
   * @param span - The completed readable span
   */
  onEnd(span: ReadableSpanInput): void {
    try {
      this.#project(span);
    } catch {
      this.#collector.drop();
    }
  }

  /**
   * Resolves immediately. The exporter's flush is the exporter's own; the
   * diagnostic collector retains synchronously, so there is nothing to
   * flush and the exporter must never be touched through this processor.
   *
   * @returns An already-resolved promise
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Marks the source closed and clears every retained record. Called by the
   * provider's shutdown — which runs after the connector session is revoked
   * — so nothing captured outlives the session. Idempotent through the
   * collector.
   *
   * @returns An already-resolved promise
   */
  shutdown(): Promise<void> {
    this.#collector.close();
    return Promise.resolve();
  }

  /** The minimization projection. Called only inside `onEnd`'s try. */
  #project(span: ReadableSpanInput): void {
    // The exact raw-name allowlist: an unapproved span is counted and
    // dropped before anything else is even read.
    const operationAlias = this.#policy.aliasByName.get(span.name);
    if (operationAlias === undefined) {
      this.#collector.drop();
      return;
    }
    const context = span.spanContext();
    if (!isTraceId(context?.traceId) || !isSpanId(context?.spanId)) {
      this.#collector.drop();
      return;
    }
    const kind = KIND_BY_OTEL_CODE.get(span.kind);
    if (kind === undefined) {
      this.#collector.drop();
      return;
    }
    const outcome = span.status === undefined
      ? 'unset'
      : OUTCOME_BY_OTEL_CODE.get(span.status.code);
    if (outcome === undefined) {
      this.#collector.drop();
      return;
    }
    const duration = spanDurationMs(span.duration);
    if (duration === null) {
      this.#collector.drop();
      return;
    }
    const parent = this.#projectParent(span, context.traceId);
    const links = this.#projectLinks(span.links);

    this.#collector.retain({
      serviceAlias: this.#policy.serviceAlias,
      operationAlias,
      traceId: context.traceId,
      spanId: context.spanId,
      links,
      kind,
      outcome,
      durationMs: duration,
      ...parent,
    });
  }

  /**
   * Resolves the parent relationship. A span with no parent context is a
   * root; a parent whose span id is not a valid W3C identifier, or whose
   * trace id differs from the span's own, leaves the relationship `unknown`
   * rather than carrying a meaningless identifier; a valid same-trace id is
   * `observed` exactly when this collector still retains that span.
   */
  #projectParent(
    span: ReadableSpanInput,
    traceId: string,
  ): { parentSpanId?: string; parentVisibility: RetainedSpanCandidate['parentVisibility'] } {
    const parent = span.parentSpanContext;
    if (parent === undefined || parent === null) {
      return { parentVisibility: 'root' };
    }
    if (!isSpanId(parent.spanId)) {
      return { parentVisibility: 'unknown' };
    }
    if (parent.traceId !== traceId) {
      return { parentVisibility: 'unknown' };
    }
    return {
      parentSpanId: parent.spanId,
      parentVisibility: this.#collector.observes(parent.spanId)
        ? 'observed'
        : 'remote-or-unobserved',
    };
  }

  /**
   * Copies at most the eight valid link identifier pairs, in order. A link
   * whose context is not a valid identifier pair is skipped — one bad link
   * never drops its span — and link attributes are never read.
   */
  #projectLinks(
    links: readonly { readonly context: ReadableSpanContextInput }[] | undefined,
  ): TraceLinkRelationship[] {
    const projected: TraceLinkRelationship[] = [];
    if (links === undefined) {
      return projected;
    }
    for (const link of links) {
      if (projected.length === MAX_LINKS_PER_SPAN) {
        break;
      }
      const context = link?.context;
      if (isTraceId(context?.traceId) && isSpanId(context?.spanId)) {
        projected.push({ traceId: context.traceId, spanId: context.spanId });
      }
    }
    return projected;
  }
}

/** Converts an OTel hrtime duration tuple to (fractional) milliseconds. */
function spanDurationMs(duration: readonly [number, number] | undefined): number | null {
  if (duration === undefined || duration.length !== 2) {
    return null;
  }
  const [seconds, nanoseconds] = duration;
  if (
    typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 ||
    typeof nanoseconds !== 'number' || !Number.isFinite(nanoseconds) || nanoseconds < 0
  ) {
    return null;
  }
  const ms = seconds * 1_000 + nanoseconds / 1_000_000;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

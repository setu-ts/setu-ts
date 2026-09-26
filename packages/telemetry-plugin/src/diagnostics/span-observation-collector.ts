/**
 * Span observation collector (M98g) — the telemetry-plugin-owned, bounded
 * completed-span ring behind `ITraceDiagnosticsSource`.
 *
 * The collector is the retention seam, not the minimization seam: the
 * diagnostic span processor has already reduced a finished span to the
 * approved field set and resolved its alias, and hands the collector a
 * candidate that carries no name, attribute, event, resource label,
 * tracestate, baggage or exception data. The collector validates that
 * candidate field by field before buffering — one malformed record is
 * counted and dropped rather than retained, because a single bad record in
 * the ring would make every later batch fail the connector's exact
 * validator until 1,024 more spans rolled it out.
 *
 * Every structure is bounded: 1,024 retained spans, 128 records per read,
 * at most eight links per span and saturating counters. Reads follow the
 * M98a cursor contract exactly: `after` is exclusive, a cursor parked behind
 * an eviction receives the oldest retained spans with the skipped sequences
 * reported as per-batch `lost`, and an empty page echoes its cursor. A read
 * never creates, ends, exports or flushes a span.
 *
 * Closing marks the collector closed FIRST (so a late retain is discarded),
 * then clears the ring and the observed-parent index.
 *
 * @module
 */
import type {
  IRuntimeServices,
  ITraceDiagnosticsSource,
  TraceCoverage,
  TraceDiagnosticsBatch,
  TraceInstrumentationKind,
  TraceLinkRelationship,
  TraceObservation,
  TraceOutcome,
  TraceParentVisibility,
  TraceSamplerDescription,
  TraceSourceState,
} from '@setu-ts/common';
import type { TraceDiagnosticsOptions } from '../interfaces/index.ts';

/**
 * The fixed collector bounds. Constants, not options — and the ONE place
 * each bound is stated, read by the collector and by its tests alike.
 *
 * @internal
 */
export const TRACE_COLLECTOR_LIMITS = {
  approvedOperations: 128,
  aliasBytes: 64,
  retainedSpans: 1_024,
  readLimit: 128,
  linksPerSpan: 8,
} as const;

const MAX_APPROVED_OPERATIONS = TRACE_COLLECTOR_LIMITS.approvedOperations;
const MAX_ALIAS_BYTES = TRACE_COLLECTOR_LIMITS.aliasBytes;
const MAX_RETAINED_SPANS = TRACE_COLLECTOR_LIMITS.retainedSpans;
const MAX_READ_LIMIT = TRACE_COLLECTOR_LIMITS.readLimit;
const MAX_LINKS = TRACE_COLLECTOR_LIMITS.linksPerSpan;

/**
 * Fixed construction and read errors. Each names the constraint it enforces
 * and never echoes a supplied value.
 *
 * @internal
 */
export const TRACE_COLLECTOR_ERRORS = {
  badOptions: 'Trace diagnostics: the diagnostics option must be an object.',
  notEnabled: 'Trace diagnostics: enabled must be the literal true.',
  badServiceAlias: 'Trace diagnostics: serviceAlias must be a string.',
  aliasBytes: 'Trace diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Trace diagnostics: an alias contains a control character.',
  badOperations: 'Trace diagnostics: operations must map exact span names to aliases.',
  tooManyOperations: 'Trace diagnostics: more than 128 approved operations.',
  duplicateAlias: 'Trace diagnostics: an operation alias is not unique.',
  badInstance: 'Trace diagnostics: read() requires a non-empty instance id string.',
  badCursor:
    'Trace diagnostics: read() requires a non-negative safe-integer cursor no greater than the ' +
    'current sequence and a limit from 1 to 128.',
} as const;

/**
 * A validated trace-observation policy, compiled once at plugin
 * construction.
 *
 * @internal
 */
export interface CompiledTraceDiagnosticsPolicy {
  /** The approved display alias for this service. */
  readonly serviceAlias: string;
  /** Exact raw span name → approved alias. */
  readonly aliasByName: ReadonlyMap<string, string>;
}

const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const SPAN_KINDS: ReadonlySet<string> = new Set([
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]);
const TRACE_OUTCOMES: ReadonlySet<string> = new Set(['ok', 'error', 'unset']);
const PARENT_VISIBILITIES: ReadonlySet<string> = new Set([
  'observed',
  'remote-or-unobserved',
  'root',
  'unknown',
]);

const ENCODER = new TextEncoder();

/** Reports whether a string carries a C0/C1 control code point. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Reports whether a value is a plain non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates one alias's SHAPE — 1–64 UTF-8 bytes, no control character. The
 * validator never inspects an alias for anything else: approving an exact
 * alias IS authorizing its disclosure.
 *
 * @param alias - The candidate alias
 * @throws {RangeError} With a fixed, value-free message
 */
function assertAliasShape(alias: string): void {
  const bytes = ENCODER.encode(alias).length;
  if (bytes < 1 || bytes > MAX_ALIAS_BYTES) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.aliasBytes);
  }
  if (hasControlCharacter(alias)) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.aliasControl);
  }
}

/**
 * Validates a W3C trace id: exactly 32 lowercase hex characters, never
 * all-zero (the W3C invalid identifier).
 *
 * @param value - The candidate identifier
 * @returns `true` for a valid trace id
 * @internal
 */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value) && value !== ALL_ZERO_TRACE_ID;
}

/**
 * Validates a W3C span id: exactly 16 lowercase hex characters, never
 * all-zero.
 *
 * @param value - The candidate identifier
 * @returns `true` for a valid span id
 * @internal
 */
export function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID_PATTERN.test(value) && value !== ALL_ZERO_SPAN_ID;
}

/**
 * Validates the trace-observation options and compiles them into the policy
 * the collector runs. The ONE validation of these options: the plugin
 * factory calls it at construction, so an invalid option refuses before any
 * application exists.
 *
 * `enabled` is checked at runtime, not only by its literal-`true` type: a
 * JavaScript or configuration-driven caller passing `enabled: false` is
 * refused rather than silently opted in.
 *
 * @param options - The raw trace-observation options
 * @returns The validated, compiled policy
 * @throws {RangeError} With a fixed, value-free message for any violation
 * @internal
 */
export function compileTraceDiagnosticsPolicy(
  options: TraceDiagnosticsOptions,
): CompiledTraceDiagnosticsPolicy {
  if (!isPlainRecord(options)) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.notEnabled);
  }
  if (typeof options.serviceAlias !== 'string') {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.badServiceAlias);
  }
  assertAliasShape(options.serviceAlias);
  if (!isPlainRecord(options.operations)) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.badOperations);
  }
  const entries = Object.entries(options.operations);
  if (entries.length > MAX_APPROVED_OPERATIONS) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.tooManyOperations);
  }
  const aliasByName = new Map<string, string>();
  const seen = new Set<string>();
  for (const [name, alias] of entries) {
    if (typeof alias !== 'string') {
      throw new RangeError(TRACE_COLLECTOR_ERRORS.badOperations);
    }
    assertAliasShape(alias);
    if (seen.has(alias)) {
      throw new RangeError(TRACE_COLLECTOR_ERRORS.duplicateAlias);
    }
    seen.add(alias);
    aliasByName.set(name, alias);
  }
  return { serviceAlias: options.serviceAlias, aliasByName };
}

/**
 * Validates `read()` arguments against the source's current sequence.
 *
 * @param instanceId - The requested instance binding
 * @param after - The exclusive cursor
 * @param limit - The requested limit, or `undefined` for the default
 * @param current - The highest sequence a cursor may name
 * @returns The effective limit
 * @throws {RangeError} With one fixed, value-free message
 * @internal
 */
export function validateTraceReadArgs(
  instanceId: unknown,
  after: unknown,
  limit: unknown,
  current: number,
): number {
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.badInstance);
  }
  const effective = limit === undefined ? MAX_READ_LIMIT : limit;
  if (
    typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after > current ||
    typeof effective !== 'number' || !Number.isInteger(effective) || effective < 1 ||
    effective > MAX_READ_LIMIT
  ) {
    throw new RangeError(TRACE_COLLECTOR_ERRORS.badCursor);
  }
  return effective;
}

/**
 * The availability facts an active collector reports on every batch. Fixed
 * at construction except the instrumentation list, which is read through a
 * thunk at READ time: the plugin learns which Node-only instrumentations
 * actually enabled only after its registry builds, and a read must report
 * the outcome, not a construction-time guess (the M52b capture-too-early
 * lesson).
 *
 * @internal
 */
export interface TraceAvailability {
  /** What completed-span population the stack makes observable. */
  readonly coverage: TraceCoverage;
  /** Reads the enabled instrumentation families at read time. */
  readonly instrumentation: () => readonly TraceInstrumentationKind[];
  /** The configured sampler description. */
  readonly sampler: TraceSamplerDescription;
}

/**
 * A candidate span the processor hands the collector after minimization. It
 * already carries aliases instead of names and no application data; the
 * collector validates it defensively before buffering.
 *
 * @internal
 */
export interface RetainedSpanCandidate {
  /** The approved display alias for the service. */
  readonly serviceAlias: string;
  /** The approved display alias for the exact raw span name. */
  readonly operationAlias: string;
  /** Validated 32-character lowercase-hex trace id. */
  readonly traceId: string;
  /** Validated 16-character lowercase-hex span id. */
  readonly spanId: string;
  /** Parent span id, present exactly when the visibility says it is meaningful. */
  readonly parentSpanId?: string;
  /** Validated link identifier pairs, at most eight. */
  readonly links: readonly TraceLinkRelationship[];
  /** The span kind. */
  readonly kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  /** How the span completed. */
  readonly outcome: TraceOutcome;
  /** Measured span duration in milliseconds. */
  readonly durationMs: number;
  /** What the source knows about the span's parent. */
  readonly parentVisibility: TraceParentVisibility;
}

/** The retention seam the diagnostic span processor calls. */
export interface SpanObservationSink {
  /**
   * Validates and retains one minimized span candidate; an invalid candidate
   * is counted as dropped and never retained.
   *
   * @param candidate - The minimized candidate
   */
  retain(candidate: RetainedSpanCandidate): void;
  /**
   * Counts one span dropped before the ring — an unapproved name above all.
   * Saturating.
   */
  drop(): void;
}

/** Recursively freezes a DTO so a reader holding it observes nothing later. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Advances a counter with saturation at `Number.MAX_SAFE_INTEGER`. */
function saturatingNext(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

/** One retained span: validated fields plus the monotonic retention instant. */
interface RetainedSpan extends RetainedSpanCandidate {
  readonly sequence: number;
  readonly retainedAtMs: number;
}

/**
 * The active collector. Implements `ITraceDiagnosticsSource` and the
 * processor-facing {@linkcode SpanObservationSink}. Constructed only when
 * the `diagnostics` option is present AND the built-in OTel provider is in
 * use.
 *
 * @internal
 */
export class SpanObservationCollector implements ITraceDiagnosticsSource, SpanObservationSink {
  readonly #availability: TraceAvailability;
  readonly #clock: Pick<IRuntimeServices, 'hrtime'>;
  readonly #spans: RetainedSpan[] = [];
  /**
   * `traceId-spanId` pairs retained in the ring, with a count per pair — the
   * 'observed' parent evidence. Keyed on the PAIR, never the span id alone:
   * a remote caller controls the incoming `traceparent`, so a span id seen in
   * one trace can be named as the parent of a span in another, and a
   * span-id-only index would then report that cross-trace edge as locally
   * observed. Counted so evicting one span never withdraws evidence another
   * retained span still carries.
   */
  readonly #observedParents = new Map<string, number>();
  #sequence = 0;
  #droppedSpans = 0;
  #closed = false;

  /**
   * Creates the collector over an already-validated availability.
   *
   * @param availability - The fixed coverage, sampler and instrumentation thunk
   * @param clock - The monotonic clock
   */
  constructor(availability: TraceAvailability, clock: Pick<IRuntimeServices, 'hrtime'>) {
    this.#availability = availability;
    this.#clock = clock;
  }

  /** {@inheritDoc SpanObservationSink.retain} */
  retain(candidate: RetainedSpanCandidate): void {
    if (this.#closed) {
      return;
    }
    // Defensive field validation BEFORE buffering: one malformed record in
    // the ring would make every later batch fail the connector's exact
    // validator until 1,024 more spans rolled it out. The processor already
    // checked these; a replaceable sink contract and a future caller are why
    // the boundary is enforced here too.
    if (
      !isAliasValue(candidate.serviceAlias) || !isAliasValue(candidate.operationAlias) ||
      !isTraceId(candidate.traceId) || !isSpanId(candidate.spanId) ||
      !SPAN_KINDS.has(candidate.kind) || !TRACE_OUTCOMES.has(candidate.outcome) ||
      !PARENT_VISIBILITIES.has(candidate.parentVisibility) ||
      typeof candidate.durationMs !== 'number' || !Number.isFinite(candidate.durationMs) ||
      candidate.durationMs < 0 || !Array.isArray(candidate.links) ||
      candidate.links.length > MAX_LINKS
    ) {
      this.#droppedSpans = saturatingNext(this.#droppedSpans);
      return;
    }
    const parentKnown = candidate.parentVisibility === 'observed' ||
      candidate.parentVisibility === 'remote-or-unobserved';
    if (parentKnown !== (candidate.parentSpanId !== undefined)) {
      this.#droppedSpans = saturatingNext(this.#droppedSpans);
      return;
    }
    if (parentKnown && !isSpanId(candidate.parentSpanId)) {
      this.#droppedSpans = saturatingNext(this.#droppedSpans);
      return;
    }
    for (const link of candidate.links) {
      if (
        !isPlainRecord(link) || !isTraceId(link.traceId) || !isSpanId(link.spanId)
      ) {
        this.#droppedSpans = saturatingNext(this.#droppedSpans);
        return;
      }
    }
    this.#sequence = saturatingNext(this.#sequence);
    const retained: RetainedSpan = {
      ...candidate,
      links: Array.from(
        candidate.links,
        (link) => ({ traceId: link.traceId, spanId: link.spanId }),
      ),
      sequence: this.#sequence,
      retainedAtMs: this.#clock.hrtime(),
    };
    this.#spans.push(retained);
    const key = parentKey(candidate.traceId, candidate.spanId);
    this.#observedParents.set(key, (this.#observedParents.get(key) ?? 0) + 1);
    if (this.#spans.length > MAX_RETAINED_SPANS) {
      const evicted = this.#spans.shift()!;
      // A parent observed before its child but already evicted correctly
      // degrades the child's visibility to `remote-or-unobserved`.
      const evictedKey = parentKey(evicted.traceId, evicted.spanId);
      const remaining = (this.#observedParents.get(evictedKey) ?? 1) - 1;
      if (remaining > 0) {
        this.#observedParents.set(evictedKey, remaining);
      } else {
        this.#observedParents.delete(evictedKey);
      }
    }
  }

  /** {@inheritDoc SpanObservationSink.drop} */
  drop(): void {
    if (this.#closed) {
      return;
    }
    this.#droppedSpans = saturatingNext(this.#droppedSpans);
  }

  /**
   * Reports whether a span with EXACTLY this trace id and span id was
   * retained by this collector and is still in the ring — the evidence for
   * `observed` parent visibility. The trace id is part of the identity: the
   * same span id in another trace is not evidence.
   *
   * @param traceId - The candidate parent's trace id
   * @param spanId - The candidate parent's span id
   * @returns `true` when that span is currently retained
   */
  observes(traceId: string, spanId: string): boolean {
    return this.#observedParents.has(parentKey(traceId, spanId));
  }

  /**
   * {@inheritDoc ITraceDiagnosticsSource.read}
   *
   * Follows the M98a cursor contract exactly: a cursor parked behind an
   * eviction receives the oldest retained spans with the skipped sequences
   * reported as per-batch `lost`, `after: 0` is not special-cased, and a
   * closed source answers an empty closed batch rather than a range refusal.
   */
  read(instanceId: string, after: number, limit?: number): TraceDiagnosticsBatch {
    const effective = validateTraceReadArgs(
      instanceId,
      after,
      limit,
      this.#closed ? Number.MAX_SAFE_INTEGER : this.#sequence,
    );
    const now = this.#clock.hrtime();
    const common = {
      version: 1 as const,
      instanceId,
      coverage: this.#availability.coverage,
      instrumentation: Object.freeze([...this.#availability.instrumentation()]),
      sampler: this.#availability.sampler,
      droppedSpans: this.#droppedSpans,
    };
    if (this.#closed) {
      return deepFreeze({
        ...common,
        state: 'no-data',
        records: [],
        next: after,
        lost: 0,
        closed: true,
      });
    }
    const first = this.#spans.length > 0 ? this.#spans[0].sequence : this.#sequence + 1;
    const start = Math.max(after + 1, first);
    const records: TraceObservation[] = [];
    for (const retained of this.#spans) {
      if (retained.sequence < start) {
        continue;
      }
      if (records.length === effective) {
        break;
      }
      const observation: TraceObservation = {
        sequence: retained.sequence,
        serviceAlias: retained.serviceAlias,
        operationAlias: retained.operationAlias,
        traceId: retained.traceId,
        spanId: retained.spanId,
        links: retained.links,
        kind: retained.kind,
        outcome: retained.outcome,
        durationMs: retained.durationMs,
        ageMs: now - retained.retainedAtMs,
        parentVisibility: retained.parentVisibility,
        ...(retained.parentSpanId === undefined ? {} : { parentSpanId: retained.parentSpanId }),
      };
      records.push(observation);
    }
    return deepFreeze({
      ...common,
      state: this.#sequence === 0 ? 'no-data' : 'ready',
      records,
      next: records.length > 0 ? records[records.length - 1]!.sequence : after,
      lost: records.length > 0 ? start - after - 1 : 0,
      closed: false,
    });
  }

  /**
   * Marks the collector closed FIRST, then clears the ring and the
   * observed-parent index. A retain arriving later finds the collector
   * closed and is discarded. Idempotent.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#spans.length = 0;
    this.#observedParents.clear();
  }
}

/**
 * The observed-parent index key. Both parts are validated fixed-length
 * lowercase hex, so the separator can never occur inside either.
 */
function parentKey(traceId: string, spanId: string): string {
  return `${traceId}-${spanId}`;
}

/** Validates one alias value without throwing (the collector's read path). */
function isAliasValue(value: unknown): value is string {
  return typeof value === 'string' && ENCODER.encode(value).length >= 1 &&
    ENCODER.encode(value).length <= MAX_ALIAS_BYTES && !hasControlCharacter(value);
}

/**
 * The inert trace-diagnostics source, registered whenever the plugin cannot
 * or does not observe: `disabled` when the application did not pass the
 * `diagnostics` option, `unsupported` when the tracing stack cannot supply
 * completed spans (custom provider factory, or noop/no-exporter mode). It
 * retains nothing — no ring, no processor — and still validates its
 * arguments with the same fixed messages as the active source.
 *
 * @param state - Why nothing is observed
 * @param availability - The stack's coverage, instrumentation and sampler
 * @returns The inactive source
 * @internal
 */
export function createInactiveTraceSource(
  state: Extract<TraceSourceState, 'disabled' | 'unsupported'>,
  availability: TraceAvailability,
): ITraceDiagnosticsSource {
  return {
    read(instanceId: string, after: number, limit?: number): TraceDiagnosticsBatch {
      validateTraceReadArgs(instanceId, after, limit, 0);
      return deepFreeze({
        version: 1,
        instanceId,
        state,
        coverage: availability.coverage,
        instrumentation: Object.freeze([]),
        sampler: availability.sampler,
        records: [],
        next: after,
        lost: 0,
        closed: false,
        droppedSpans: 0,
      });
    },
  };
}

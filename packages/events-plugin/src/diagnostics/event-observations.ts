/**
 * Event dispatch observations (M98j) — the EventsPlugin-owned bounded
 * collector behind `IEventDiagnosticsSource`.
 *
 * The collector is the minimization seam. The bus hands it an already-approved
 * alias, a fixed operation and a settled outcome/duration — never an event
 * object, an event type, a payload, an identifier or a thrown value, none of
 * which the observation signatures can even accept. Alias resolution happens
 * BEFORE the collector is consulted, through the exact approved map, so an
 * unapproved type is neither observed nor counted.
 *
 * Every structure is bounded: at most 64 record slots keyed by (alias,
 * operation), each expiring 60 seconds after its last observation (checked
 * during update/read, never by a background timer). `dropped` counts tuples
 * ignored at capacity, saturating. Closing marks the source closed FIRST so a
 * late observation is discarded, then clears every slot.
 *
 * @module
 */
import type {
  EventDiagnosticsRecord,
  EventDiagnosticsSnapshot,
  EventDiagnosticsState,
  EventObservationOperation,
  IEventDiagnosticsSource,
  IRuntimeServices,
} from '@setu-ts/common';
import type { EventsDiagnosticsOptions } from '../interfaces/index.ts';

/**
 * The fixed collector bounds. Constants, not options — and the ONE place each
 * bound is stated, read by the collector and by its tests alike.
 *
 * @internal
 */
export const EVENT_COLLECTOR_LIMITS = {
  /** Record slots per source, keyed by (alias, operation). */
  recordSlots: 64,
  /** Approved event-type entries per source. */
  approvedTypes: 64,
  /** UTF-8 byte bound of an alias. */
  aliasBytes: 64,
  /** Milliseconds without an observation before a record expires. */
  retentionMs: 60_000,
  /** Milliseconds of age beyond which every retained record reads `stale`. */
  staleMs: 30_000,
} as const;

const MAX_RECORD_SLOTS = EVENT_COLLECTOR_LIMITS.recordSlots;
const MAX_APPROVED_TYPES = EVENT_COLLECTOR_LIMITS.approvedTypes;
const MAX_ALIAS_BYTES = EVENT_COLLECTOR_LIMITS.aliasBytes;
const RETENTION_MS = EVENT_COLLECTOR_LIMITS.retentionMs;
const STALE_MS = EVENT_COLLECTOR_LIMITS.staleMs;
/** Minimum interval between write-path expiry scans. */
const EXPIRY_SCAN_INTERVAL_MS = 1_000;

/**
 * Fixed construction errors. Each names the constraint it enforces and never
 * echoes a supplied value.
 *
 * @internal
 */
export const EVENT_COLLECTOR_ERRORS = {
  badOptions: 'Event diagnostics: the diagnostics option must be an object.',
  notEnabled: 'Event diagnostics: enabled must be the literal true.',
  badAlias: 'Event diagnostics: alias must be a string.',
  aliasBytes: 'Event diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Event diagnostics: an alias contains a control character.',
  badEvents: 'Event diagnostics: events must map event types to aliases.',
  tooManyEvents: 'Event diagnostics: more than 64 approved event types.',
  duplicateAlias: 'Event diagnostics: an event alias is not unique.',
} as const;

/** C0/C1 control code points, described by code point to avoid a literal regex class. */
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

const ENCODER = new TextEncoder();

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
    throw new RangeError(EVENT_COLLECTOR_ERRORS.aliasBytes);
  }
  if (hasControlCharacter(alias)) {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.aliasControl);
  }
}

/**
 * A validated event-observation policy, compiled once at plugin construction.
 *
 * @internal
 */
export interface CompiledEventsDiagnosticsPolicy {
  /** The configured display alias for this bus instance. */
  readonly alias: string;
  /** Exact event type → approved alias. */
  readonly aliasByType: ReadonlyMap<string, string>;
  /** `true` when the events map approved at least one observation. */
  readonly hasApprovals: boolean;
}

/**
 * Validates the event-observation options and compiles them into the policy
 * the collector runs. The ONE validation of these options: the plugin factory
 * calls it at construction, so an invalid option refuses before any
 * application exists.
 *
 * `enabled` is checked at runtime, not only by its literal-`true` type: a
 * JavaScript or configuration-driven caller passing `enabled: false` is
 * refused rather than silently opted in.
 *
 * @param options - The raw event-observation options
 * @returns The validated, compiled policy
 * @throws {RangeError} With a fixed, value-free message for any violation
 * @internal
 */
export function compileEventsDiagnosticsPolicy(
  options: EventsDiagnosticsOptions,
): CompiledEventsDiagnosticsPolicy {
  if (!isPlainRecord(options)) {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.notEnabled);
  }
  if (typeof options.alias !== 'string') {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.badAlias);
  }
  assertAliasShape(options.alias);
  // `events` is REQUIRED when diagnostics is supplied: an instance opted in
  // with no approved type is a configuration mistake, not an empty observer.
  if (!isPlainRecord(options.events)) {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.badEvents);
  }
  // Own entries only: an inherited property (`toString`, a prototype member)
  // must never become an approved observation.
  const entries = Object.entries(options.events);
  if (entries.length > MAX_APPROVED_TYPES) {
    throw new RangeError(EVENT_COLLECTOR_ERRORS.tooManyEvents);
  }
  const aliasByType = new Map<string, string>();
  const seen = new Set<string>();
  for (const [type, alias] of entries) {
    if (typeof alias !== 'string') {
      throw new RangeError(EVENT_COLLECTOR_ERRORS.badEvents);
    }
    assertAliasShape(alias);
    if (seen.has(alias)) {
      throw new RangeError(EVENT_COLLECTOR_ERRORS.duplicateAlias);
    }
    seen.add(alias);
    aliasByType.set(type, alias);
  }
  return { alias: options.alias, aliasByType, hasApprovals: aliasByType.size > 0 };
}

/** Advances a counter with saturation at `Number.MAX_SAFE_INTEGER`. */
function saturatingNext(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

/** Clamps a duration to a non-negative integer millisecond count. */
function clampDuration(rawMs: number): number {
  const ms = Math.floor(rawMs);
  return ms < 0 ? 0 : Math.min(ms, Number.MAX_SAFE_INTEGER);
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

/** One aggregate observation slot, keyed by (alias, operation). */
interface ObservationSlot {
  readonly alias: string;
  readonly operation: EventObservationOperation;
  count: number;
  started: number;
  succeeded: number;
  failed: number;
  noSubscribers: number;
  lastDurationMs: number | null;
  lastSettledAtMs: number | null;
  /** Last start or settlement; drives expiry, so a never-settled slot ages out too. */
  lastSeenAtMs: number;
}

/**
 * The inert, disabled event-diagnostics source, registered when the events
 * plugin's `diagnostics` option is absent. It observes nothing — no slots, no
 * clock reads — and answers a deeply frozen `disabled` snapshot with a `null`
 * alias.
 *
 * @returns The disabled source
 * @internal
 */
export function createDisabledEventSource(): IEventDiagnosticsSource {
  return {
    snapshot(): EventDiagnosticsSnapshot {
      return deepFreeze({
        state: 'disabled' as const,
        alias: null,
        coverage: 'owned-instance' as const,
        records: Object.freeze([]) as readonly EventDiagnosticsRecord[],
        dropped: 0,
      });
    },
  };
}

/**
 * The collector. Implements `IEventDiagnosticsSource` and the internal
 * observer seam the bus calls. Constructed only when the events plugin's
 * `diagnostics` option is present.
 *
 * @internal
 */
export class EventObservationCollector implements IEventDiagnosticsSource {
  readonly #policy: CompiledEventsDiagnosticsPolicy;
  readonly #clock: IRuntimeServices;
  /** (alias, operation) → aggregate slot, insertion-ordered for stable reads. */
  readonly #slots = new Map<string, ObservationSlot>();
  /**
   * The same slots indexed by alias, so the hot path finds a slot without
   * building a key string. Kept in step with {@linkcode #slots}.
   */
  readonly #byAlias = new Map<string, { publish?: ObservationSlot; handler?: ObservationSlot }>();
  /** Monotonic reading of the last write-path expiry scan. */
  #lastExpireAt = Number.NEGATIVE_INFINITY;
  #dropped = 0;
  #closed = false;
  /**
   * Latched when an observer or clock read throws: observation stops until
   * the source is recreated, so a broken clock can never distort or discard
   * application behavior silently.
   */
  #collectionFailed = false;

  constructor(policy: CompiledEventsDiagnosticsPolicy, clock: IRuntimeServices) {
    this.#policy = policy;
    this.#clock = clock;
  }

  /**
   * The approved alias for an exact event type, or `undefined` when the type
   * is not approved. Own-map lookup only — the collector never sees a type
   * that failed the allowlist.
   */
  aliasFor(type: string): string | undefined {
    return this.#policy.aliasByType.get(type);
  }

  /**
   * Records that one dispatch boundary STARTED for an already-approved alias
   * and returns the monotonic start reading the matching {@linkcode end}
   * measures from. `started` is counted here, at the start, so an in-flight
   * (or hung) handler is visible as `started > count` before it settles.
   *
   * Never throws: a failing clock latches `collection-failed` and returns
   * `null`, so observation can never change the application's result.
   *
   * @param alias - The already-approved alias
   * @param operation - Which dispatch boundary started
   * @param at - A reading the caller already holds (the previous boundary's
   * settlement), reused instead of reading the clock again; `null` means
   * the clock has already failed
   * @returns The start reading, or `null` when nothing is being captured
   */
  begin(
    alias: string,
    operation: EventObservationOperation,
    at?: number | null,
  ): number | null {
    const now = at === undefined
      ? this.#read()
      : this.#closed || this.#collectionFailed
      ? null
      : at;
    if (now === null) {
      return null;
    }
    try {
      const slot = this.#slotFor(alias, operation, false);
      if (slot !== null) {
        slot.started = saturatingNext(slot.started);
        slot.lastSeenAtMs = now;
      }
      return now;
    } catch {
      this.#collectionFailed = true;
      return null;
    }
  }

  /**
   * Records that a boundary {@linkcode begin} opened has SETTLED. Only
   * framework-owned primitives cross this seam: the approved alias, the
   * fixed operation, the outcome and whether a publication found no
   * subscriber — never an event object, its type or a thrown value.
   *
   * Never throws. A `null` start (the clock had already failed) records
   * nothing.
   *
   * @param alias - The already-approved alias
   * @param operation - Which dispatch boundary settled
   * @param startedAt - The reading {@linkcode begin} returned
   * @param succeeded - Whether the boundary completed normally
   * @param noSubscribers - For `publish`, whether no handler was subscribed
   * @param at - A settlement reading the caller already holds, reused
   * instead of reading the clock again
   * @returns The settlement reading (for the next boundary to reuse), or
   * `null` when nothing is being captured
   */
  end(
    alias: string,
    operation: EventObservationOperation,
    startedAt: number | null,
    succeeded: boolean,
    noSubscribers = false,
    at?: number | null,
  ): number | null {
    // A caller-held reading must not bypass the lifecycle: after close() or
    // a latched failure nothing is recorded (audit F1).
    if (startedAt === null || this.#closed || this.#collectionFailed) {
      return null;
    }
    const now = at === undefined ? this.#read() : at;
    if (now === null) {
      return null;
    }
    this.observe(alias, operation, succeeded, now - startedAt, noSubscribers, now);
    return this.#closed || this.#collectionFailed ? null : now;
  }

  /**
   * Records one settled observation with an already-measured duration. The
   * settle half of {@linkcode end}; it does not count a start. Every failure
   * inside is contained — observation never changes the application's
   * dispatch result or timing.
   *
   * @param alias - The already-approved alias
   * @param operation - Which dispatch boundary settled
   * @param succeeded - Whether the observation completed normally
   * @param durationMs - The measured duration; clamped
   * @param noSubscribers - For `publish`, whether no handler was subscribed
   * @param at - The settlement reading; read from the clock when omitted
   */
  observe(
    alias: string,
    operation: EventObservationOperation,
    succeeded: boolean,
    durationMs: number,
    noSubscribers = false,
    at?: number,
  ): void {
    if (this.#closed || this.#collectionFailed) {
      return;
    }
    const now = at ?? this.#read();
    if (now === null) {
      return;
    }
    try {
      const slot = this.#slotFor(alias, operation);
      if (slot === null) {
        return;
      }
      slot.count = saturatingNext(slot.count);
      if (succeeded) {
        slot.succeeded = saturatingNext(slot.succeeded);
      } else {
        slot.failed = saturatingNext(slot.failed);
      }
      if (operation === 'publish' && noSubscribers) {
        slot.noSubscribers = saturatingNext(slot.noSubscribers);
      }
      slot.lastDurationMs = clampDuration(durationMs);
      slot.lastSettledAtMs = now;
      slot.lastSeenAtMs = now;
      // The write path scans for expired slots at most once per second, so
      // a publish does not pay an O(64) walk; `snapshot()` always scans, so
      // a read never reports a record past the retention window.
      if (now - this.#lastExpireAt >= EXPIRY_SCAN_INTERVAL_MS) {
        this.#expire(now);
      }
    } catch {
      this.#collectionFailed = true;
    }
  }

  /** Reads the clock once; a failure latches `collection-failed`. */
  #read(): number | null {
    if (this.#closed || this.#collectionFailed) {
      return null;
    }
    try {
      return this.#clock.hrtime();
    } catch {
      this.#collectionFailed = true;
      return null;
    }
  }

  /**
   * The slot for (alias, operation), created on first use. At capacity the
   * NEW tuple is ignored and `dropped` counted; existing tuples keep
   * updating. Reachable with a valid policy: each approved alias can occupy
   * two slots (publish + handler), so more than 32 active aliases fill the
   * 64 slots.
   */
  #slotFor(
    alias: string,
    operation: EventObservationOperation,
    countDrop = true,
  ): ObservationSlot | null {
    const pair = this.#byAlias.get(alias);
    let slot = pair?.[operation];
    if (slot === undefined) {
      if (this.#slots.size >= MAX_RECORD_SLOTS) {
        // A refused start and its settlement are one ignored observation:
        // only the settlement counts the drop.
        if (countDrop) {
          this.#dropped = saturatingNext(this.#dropped);
        }
        return null;
      }
      slot = {
        alias,
        operation,
        count: 0,
        started: 0,
        succeeded: 0,
        failed: 0,
        noSubscribers: 0,
        lastDurationMs: null,
        lastSettledAtMs: null,
        lastSeenAtMs: 0,
      };
      this.#slots.set(`${operation}\u0000${alias}`, slot);
      if (pair === undefined) {
        this.#byAlias.set(alias, { [operation]: slot });
      } else {
        pair[operation] = slot;
      }
    }
    return slot;
  }

  /**
   * Drops slots whose last start or settlement is older than the retention window,
   * clearing their counters. Checked during update and read — never by a
   * background timer.
   */
  #expire(now: number): void {
    this.#lastExpireAt = now;
    for (const [key, slot] of this.#slots) {
      if (now - slot.lastSeenAtMs > RETENTION_MS) {
        this.#slots.delete(key);
        const pair = this.#byAlias.get(slot.alias);
        if (pair !== undefined) {
          delete pair[slot.operation];
          if (pair.publish === undefined && pair.handler === undefined) {
            this.#byAlias.delete(slot.alias);
          }
        }
      }
    }
  }

  /** {@inheritDoc IEventDiagnosticsSource.snapshot} */
  snapshot(): EventDiagnosticsSnapshot {
    if (this.#closed) {
      return deepFreeze({
        state: 'disabled' as const,
        alias: null,
        coverage: 'owned-instance' as const,
        records: Object.freeze([]) as readonly EventDiagnosticsRecord[],
        dropped: 0,
      });
    }
    if (this.#collectionFailed) {
      return deepFreeze({
        state: 'collection-failed' as EventDiagnosticsState,
        alias: this.#policy.alias,
        coverage: 'owned-instance' as const,
        records: Object.freeze([]) as readonly EventDiagnosticsRecord[],
        dropped: this.#dropped,
      });
    }
    let now: number;
    try {
      now = this.#clock.hrtime();
    } catch {
      this.#collectionFailed = true;
      return this.snapshot();
    }
    this.#expire(now);
    const records: EventDiagnosticsRecord[] = [];
    for (const slot of this.#slots.values()) {
      const ageMs = Math.max(0, now - (slot.lastSettledAtMs ?? slot.lastSeenAtMs));
      records.push({
        alias: slot.alias,
        operation: slot.operation,
        count: slot.count,
        started: slot.started,
        succeeded: slot.succeeded,
        failed: slot.failed,
        noSubscribers: slot.noSubscribers,
        lastDurationMs: slot.lastDurationMs,
        ageMs: clampDuration(ageMs),
      });
    }
    const state: EventDiagnosticsState = records.length === 0
      ? 'no-data'
      : records.every((record) => record.ageMs > STALE_MS)
      ? 'stale'
      : 'ready';
    return deepFreeze({
      state,
      alias: this.#policy.alias,
      coverage: 'owned-instance' as const,
      records: Object.freeze(records) as readonly EventDiagnosticsRecord[],
      dropped: this.#dropped,
    });
  }

  /**
   * Marks the collector closed FIRST, so a late observation is discarded,
   * then clears every slot. Idempotent.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#slots.clear();
    this.#byAlias.clear();
  }
}

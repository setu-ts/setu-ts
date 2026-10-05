/**
 * The bounded outbound HTTP attempt collector (M98n).
 *
 * One collector per `createObservedFetch` helper. It holds at most ONE record
 * and accepts only primitives: a begin reading and, at settlement, whether
 * the attempt resolved and the response's status class. A URL, header, body,
 * signal or thrown value has no parameter to arrive through.
 *
 * This is a deliberate local copy of three small pieces that also exist as
 * runtime code in `@setu-ts/common` (alias validation, the saturating counter
 * and the freshness rule): importing them would give the SDK its first
 * runtime import of `common` and end its type-only, browser-portable
 * property. A shared alias test table keeps the two copies in agreement.
 *
 * @module
 * @internal
 */

import type {
  DiagnosticsInspectorState,
  IOutboundHttpDiagnosticsSource,
  OutboundHttpDiagnosticsRecord,
  OutboundHttpDiagnosticsSnapshot,
  OutboundHttpStatusClass,
} from 'jsr:@setu-ts/common@^0.8.0';

/**
 * The fixed collector bounds. Constants, not options.
 *
 * @internal
 */
export const OUTBOUND_HTTP_LIMITS = {
  /** Maximum UTF-8 bytes of the approved alias. */
  aliasBytes: 64,
  /** An idle record (nothing in flight) older than this is expired. */
  retentionMs: 60_000,
  /** A record whose last activity is older than this is `stale`. */
  staleMs: 30_000,
} as const;

/**
 * The fixed, value-free alias refusals.
 *
 * @internal
 */
export const OUTBOUND_ALIAS_ERRORS = {
  type: 'createObservedFetch: alias must be a string.',
  bytes: 'createObservedFetch: an alias must be 1 to 64 UTF-8 bytes.',
  control: 'createObservedFetch: an alias contains a control, format or line-separator character.',
} as const;

const ENCODER = new TextEncoder();

/**
 * Validates an approved display alias with a fixed, value-free message.
 *
 * @param alias - The supplied alias
 * @returns The alias
 * @throws {TypeError} When the alias is not a string
 * @throws {RangeError} When it is outside 1–64 UTF-8 bytes or has a control character
 * @internal
 */
export function compileOutboundAlias(alias: unknown): string {
  if (typeof alias !== 'string') {
    throw new TypeError(OUTBOUND_ALIAS_ERRORS.type);
  }
  const bytes = ENCODER.encode(alias).length;
  if (bytes < 1 || bytes > OUTBOUND_HTTP_LIMITS.aliasBytes) {
    throw new RangeError(OUTBOUND_ALIAS_ERRORS.bytes);
  }
  for (const character of alias) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      throw new RangeError(OUTBOUND_ALIAS_ERRORS.control);
    }
  }
  return alias;
}

/**
 * Reduces a response status to its fixed class.
 *
 * @param status - The raw `status` value
 * @returns `2xx`–`5xx` for an integer in `200..599`, otherwise `other`
 * @internal
 */
export function statusClassOf(status: unknown): OutboundHttpStatusClass {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    return 'other';
  }
  if (status < 300) {
    return '2xx';
  }
  if (status < 400) {
    return '3xx';
  }
  return status < 500 ? '4xx' : '5xx';
}

/**
 * Saturating increment at `Number.MAX_SAFE_INTEGER`.
 *
 * @param value - The current counter
 * @returns The incremented, clamped counter
 * @internal
 */
export function bump(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

/** Clamps a measurement to a non-negative integer millisecond count. */
function clampMs(raw: number): number {
  const ms = Math.floor(raw);
  return ms > 0 ? Math.min(ms, Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * The opaque token one attempt carries from begin to settlement.
 *
 * @internal
 */
export interface AttemptToken {
  readonly generation: number;
  readonly start: number;
}

/** The monotonic clock the collector reads, always as a method call. */
export interface CollectorClock {
  now(): number;
}

/** The mutable counters behind the one record. */
interface MutableRecord {
  started: number;
  count: number;
  responses: number;
  failures: number;
  lastStatusClass: OutboundHttpStatusClass | null;
  lastDurationMs: number | null;
  lastAt: number;
}

/**
 * The collector behind one helper.
 *
 * @internal
 */
export class OutboundHttpCollector {
  readonly #alias: string;
  readonly #clock: CollectorClock;
  #record: MutableRecord | null = null;
  #generation = 0;
  #failed = false;
  #closed = false;
  /** The frozen snapshot-only facade handed to the diagnostics registry. */
  readonly source: IOutboundHttpDiagnosticsSource = Object.freeze({
    snapshot: (): OutboundHttpDiagnosticsSnapshot => this.snapshot(),
  });

  constructor(alias: string, clock: CollectorClock) {
    this.#alias = alias;
    this.#clock = clock;
  }

  /**
   * Records that one delegation is starting. Never throws.
   *
   * @returns The attempt's token, or `null` when nothing is being recorded
   */
  begin(): AttemptToken | null {
    if (this.#closed || this.#failed) {
      return null;
    }
    const now = this.#read();
    if (now === null) {
      return null;
    }
    this.#expireIdle(now);
    const record = this.#record ?? this.#fresh(now);
    record.started = bump(record.started);
    record.lastAt = Math.max(record.lastAt, now);
    return { generation: this.#generation, start: now };
  }

  /**
   * Records one settlement. Never throws. A token from an earlier generation
   * (before a close, reopen or failure) is discarded, so `count` never
   * exceeds `started` and no reading moves backwards.
   *
   * @param token - The token `begin()` returned
   * @param responded - Whether the attempt resolved
   * @param statusClass - The response's class when it resolved
   */
  settle(
    token: AttemptToken | null,
    responded: boolean,
    statusClass: OutboundHttpStatusClass,
  ): void {
    if (
      token === null || this.#closed || this.#failed || token.generation !== this.#generation ||
      this.#record === null
    ) {
      return;
    }
    const now = this.#read();
    if (now === null) {
      return;
    }
    const record = this.#record;
    record.count = bump(record.count);
    if (responded) {
      record.responses = bump(record.responses);
      record.lastStatusClass = statusClass;
    } else {
      record.failures = bump(record.failures);
    }
    record.lastDurationMs = clampMs(now - token.start);
    record.lastAt = Math.max(record.lastAt, now);
  }

  /**
   * Returns a deeply frozen snapshot. A clock failure latches
   * `collection-failed`.
   *
   * @returns The snapshot
   */
  snapshot(): OutboundHttpDiagnosticsSnapshot {
    if (this.#closed) {
      return freezeSnapshot('disabled', null, []);
    }
    if (this.#failed) {
      return freezeSnapshot('collection-failed', this.#alias, []);
    }
    const now = this.#read();
    if (now === null) {
      return freezeSnapshot('collection-failed', this.#alias, []);
    }
    this.#expireIdle(now);
    const record = this.#record;
    if (record === null) {
      return freezeSnapshot('no-data', this.#alias, []);
    }
    const ageMs = clampMs(now - record.lastAt);
    const state = ageMs > OUTBOUND_HTTP_LIMITS.staleMs ? 'stale' : 'ready';
    const projected: OutboundHttpDiagnosticsRecord = Object.freeze({
      alias: this.#alias,
      operation: 'attempt',
      started: record.started,
      count: record.count,
      responses: record.responses,
      failures: record.failures,
      lastStatusClass: record.lastStatusClass,
      lastDurationMs: record.lastDurationMs,
      ageMs,
    });
    return freezeSnapshot(state, this.#alias, [projected]);
  }

  /** Marks the helper closed before clearing; later settlements record nothing. */
  close(): void {
    this.#closed = true;
    this.#record = null;
    this.#generation++;
  }

  /**
   * Reopens a closed helper for the same application's next start. A
   * collection failure stays latched.
   */
  reopen(): void {
    if (this.#closed) {
      this.#closed = false;
      this.#generation++;
    }
  }

  /** Creates the one record. */
  #fresh(now: number): MutableRecord {
    const record: MutableRecord = {
      started: 0,
      count: 0,
      responses: 0,
      failures: 0,
      lastStatusClass: null,
      lastDurationMs: null,
      lastAt: now,
    };
    this.#record = record;
    return record;
  }

  /** Expires an idle record; a record with attempts in flight never expires. */
  #expireIdle(now: number): void {
    const record = this.#record;
    if (
      record !== null && record.count >= record.started &&
      now - record.lastAt > OUTBOUND_HTTP_LIMITS.retentionMs
    ) {
      this.#record = null;
      this.#generation++;
    }
  }

  /** Reads the clock once, as a method call; a failure latches `collection-failed`. */
  #read(): number | null {
    try {
      const now = this.#clock.now();
      if (typeof now !== 'number' || !Number.isFinite(now)) {
        this.#fail();
        return null;
      }
      return now;
    } catch {
      this.#fail();
      return null;
    }
  }

  /** Latches `collection-failed`, discarding the record. */
  #fail(): void {
    this.#failed = true;
    this.#record = null;
    this.#generation++;
  }
}

/** Builds a deeply frozen snapshot. */
function freezeSnapshot(
  state: DiagnosticsInspectorState,
  alias: string | null,
  records: readonly OutboundHttpDiagnosticsRecord[],
): OutboundHttpDiagnosticsSnapshot {
  return Object.freeze({
    state,
    alias,
    coverage: 'owned-instance',
    records: Object.freeze([...records]),
  });
}

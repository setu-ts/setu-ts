/**
 * Opt-in cache operation counters (M98i) — the bounded collector behind
 * `CachePlugin({ diagnostics })` and the `ICacheDiagnosticsSource` every
 * CachePlugin instance registers under `CAPABILITIES.CACHE_DIAGNOSTICS`.
 *
 * INTERNAL: nothing here is exported from the package barrel. The collector
 * is attached to the plugin's OWN `CacheService` through a private field set
 * by the internal `attachCacheCollector` in `cache-service.ts`, so the
 * service's exported constructor is unchanged and a service with no
 * collector does one field read beyond the pre-M98i code path — no clock
 * read, no label, no extra promise, no allocation.
 *
 * What crosses into the collector is only a fixed operation name, a fixed
 * outcome code and at most two monotonic clock readings. Keys, prefixes, values,
 * factory results, TTLs and thrown values never do: the wrapper classifies
 * a result into a primitive detail code before calling the collector, and a
 * rejection is recorded as `failed` without the error ever being read.
 *
 * @module
 */
import { hasForbiddenAliasCharacter } from '@setu-ts/common';
import type {
  CacheDiagnosticsOperation,
  CacheDiagnosticsRecord,
  CacheDiagnosticsSnapshot,
  DiagnosticsInspectorState,
  ICacheDiagnosticsSource,
} from '@setu-ts/common';
import type { CacheDiagnosticsOptions } from '../interfaces/index.ts';

/**
 * The fixed collector bounds. Constants, not options.
 *
 * @internal
 */
export const CACHE_COLLECTOR_LIMITS = {
  /** Maximum UTF-8 bytes of the approved alias. */
  aliasBytes: 64,
  /** A record older than this (ms since its last observation) is expired and cleared. */
  retentionMs: 60_000,
  /** A snapshot whose freshest record is older than this (ms) is `stale`. */
  staleMs: 30_000,
  /**
   * One in this many calls per operation is TIMED (the first always is): a
   * timed call reads the clock at start and settle, every other call only at
   * settle. Halves the per-call clock cost; see `lastDurationMs`.
   */
  timingSampleInterval: 8,
} as const;

/**
 * What {@linkcode CacheObservationCollector.begin} returns for a call that is
 * counted but not timed.
 *
 * @internal
 */
export const UNTIMED = 'untimed';

/** A call's start marker: a clock reading, untimed, or `null` (not observed). */
export type CacheCallStart = number | typeof UNTIMED | null;

/**
 * The fixed, value-free refusal messages. None echoes a supplied value.
 *
 * @internal
 */
export const CACHE_DIAGNOSTICS_ERRORS = {
  shape: 'Cache diagnostics: options must be an object { enabled: true, alias }.',
  enabled: 'Cache diagnostics: enabled must be the literal true; omit diagnostics instead.',
  aliasType: 'Cache diagnostics: alias must be a string.',
  aliasBytes: 'Cache diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl:
    'Cache diagnostics: an alias contains a control, format or line-separator character.',
  extraKey: 'Cache diagnostics: options accept only enabled and alias.',
} as const;

/** The option keys the policy admits. */
const OPTION_KEYS: ReadonlySet<string> = new Set(['enabled', 'alias']);

const ENCODER = new TextEncoder();

/**
 * Validates the cache-diagnostics options and returns the approved alias.
 * The ONE validation of these options: the plugin factory calls it when
 * `CachePlugin(...)` is called, so an invalid option refuses before any
 * application exists. `enabled` is checked at runtime, not only by its
 * literal type, so a configuration-driven `enabled: false` is refused
 * rather than silently opted in.
 *
 * @param options - The supplied options
 * @returns The approved display alias
 * @throws {TypeError | RangeError} With a fixed, value-free message
 * @internal
 */
export function compileCacheDiagnosticsAlias(options: CacheDiagnosticsOptions): string {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(CACHE_DIAGNOSTICS_ERRORS.shape);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(CACHE_DIAGNOSTICS_ERRORS.extraKey);
    }
  }
  if (options.enabled !== true) {
    throw new TypeError(CACHE_DIAGNOSTICS_ERRORS.enabled);
  }
  const alias: unknown = options.alias;
  if (typeof alias !== 'string') {
    throw new TypeError(CACHE_DIAGNOSTICS_ERRORS.aliasType);
  }
  const bytes = ENCODER.encode(alias).length;
  if (bytes < 1 || bytes > CACHE_COLLECTOR_LIMITS.aliasBytes) {
    throw new RangeError(CACHE_DIAGNOSTICS_ERRORS.aliasBytes);
  }
  if (hasForbiddenAliasCharacter(alias)) {
    throw new RangeError(CACHE_DIAGNOSTICS_ERRORS.aliasControl);
  }
  return alias;
}

/**
 * The primitive classification of one settled backend call. The wrapper
 * derives it from the result BEFORE calling the collector, so no result
 * value reaches it.
 *
 * @internal
 */
export type CacheCallOutcome =
  | 'failed'
  | 'succeeded'
  | 'hit'
  | 'miss'
  | 'present'
  | 'absent'
  | 'removed'
  | 'not-removed';

/** The mutable counters behind one record. */
interface MutableRecord {
  count: number;
  succeeded: number;
  failed: number;
  hits: number;
  misses: number;
  present: number;
  absent: number;
  removed: number;
  notRemoved: number;
  lastDurationMs: number | null;
  lastAt: number;
}

/** The fixed operation order records are reported in. */
const OPERATIONS: readonly CacheDiagnosticsOperation[] = ['get', 'set', 'delete', 'has', 'clear'];

/**
 * Saturating increment: every counter clamps independently at
 * `Number.MAX_SAFE_INTEGER`.
 *
 * @param value - The current counter
 * @returns The incremented, clamped counter
 * @internal
 */
export function bump(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

/**
 * The bounded collector for one CachePlugin instance. At most one record per
 * fixed operation for its one approved alias (five in all), so the record
 * set is bounded by construction and no observation is ever dropped for
 * want of a slot — `dropped` stays `0`, and exists on the snapshot contract
 * for sources whose slot set is not fixed.
 *
 * Every entry point catches its own failures: a throwing clock (or any
 * internal fault) latches `collection-failed`, clears the records and stops
 * capture until the plugin instance is recreated. Nothing it does can change
 * an application result or error.
 *
 * @internal
 */
export class CacheObservationCollector {
  readonly #alias: string;
  readonly #clock: () => number;
  readonly #records = new Map<CacheDiagnosticsOperation, MutableRecord>();
  /** Per-operation position in the timing sample cycle; `0` means "time the next call". */
  readonly #cycle = new Map<CacheDiagnosticsOperation, number>();
  #failed = false;
  #closed = false;

  /**
   * @param alias - The approved display alias
   * @param clock - The runtime's monotonic clock (`runtime.hrtime`)
   */
  constructor(alias: string, clock: () => number) {
    this.#alias = alias;
    this.#clock = clock;
  }

  /**
   * Marks the start of a call. The first call per operation, and one in
   * every `timingSampleInterval` after it, reads the clock and is timed;
   * the rest are counted without a start reading.
   *
   * @param operation - The backend operation starting
   * @returns The monotonic start reading, {@linkcode UNTIMED}, or `null`
   * when capture has stopped or the clock threw (which latches
   * `collection-failed`)
   */
  begin(operation: CacheDiagnosticsOperation): CacheCallStart {
    if (this.#failed || this.#closed) {
      return null;
    }
    const position = this.#cycle.get(operation) ?? 0;
    this.#cycle.set(operation, (position + 1) % CACHE_COLLECTOR_LIMITS.timingSampleInterval);
    if (position !== 0) {
      return UNTIMED;
    }
    try {
      return this.#clock();
    } catch {
      this.#fail();
      return null;
    }
  }

  /**
   * Records one settled backend call.
   *
   * @param operation - The fixed backend operation
   * @param start - What {@linkcode begin} returned; `null` skips the call
   * @param outcome - The primitive classification of the call
   */
  settle(
    operation: CacheDiagnosticsOperation,
    start: CacheCallStart,
    outcome: CacheCallOutcome,
  ): void {
    if (start === null || this.#failed || this.#closed) {
      return;
    }
    try {
      const now = this.#clock();
      let record = this.#records.get(operation);
      if (record === undefined || now - record.lastAt > CACHE_COLLECTOR_LIMITS.retentionMs) {
        record = {
          count: 0,
          succeeded: 0,
          failed: 0,
          hits: 0,
          misses: 0,
          present: 0,
          absent: 0,
          removed: 0,
          notRemoved: 0,
          lastDurationMs: null,
          lastAt: now,
        };
        this.#records.set(operation, record);
      }
      record.count = bump(record.count);
      if (outcome === 'failed') {
        record.failed = bump(record.failed);
      } else {
        record.succeeded = bump(record.succeeded);
        switch (outcome) {
          case 'hit':
            record.hits = bump(record.hits);
            break;
          case 'miss':
            record.misses = bump(record.misses);
            break;
          case 'present':
            record.present = bump(record.present);
            break;
          case 'absent':
            record.absent = bump(record.absent);
            break;
          case 'removed':
            record.removed = bump(record.removed);
            break;
          case 'not-removed':
            record.notRemoved = bump(record.notRemoved);
            break;
        }
      }
      if (start !== UNTIMED) {
        record.lastDurationMs = Math.round(Math.max(0, now - start));
      }
      record.lastAt = now;
    } catch {
      this.#fail();
    }
  }

  /**
   * Marks the collector closed and clears every record. Late settlements
   * are ignored and cannot repopulate it.
   */
  close(): void {
    this.#closed = true;
    this.#records.clear();
    this.#cycle.clear();
  }

  /**
   * Builds the frozen snapshot. Expired records are cleared first.
   *
   * @returns The deeply frozen snapshot
   */
  snapshot(): CacheDiagnosticsSnapshot {
    if (this.#closed) {
      return disabledCacheSnapshot();
    }
    if (this.#failed) {
      return failedSnapshot(this.#alias);
    }
    let now: number;
    try {
      now = this.#clock();
    } catch {
      this.#fail();
      return failedSnapshot(this.#alias);
    }
    const records: CacheDiagnosticsRecord[] = [];
    let freshest = Number.POSITIVE_INFINITY;
    for (const operation of OPERATIONS) {
      const record = this.#records.get(operation);
      if (record === undefined) {
        continue;
      }
      const age = Math.max(0, now - record.lastAt);
      if (age > CACHE_COLLECTOR_LIMITS.retentionMs) {
        this.#records.delete(operation);
        continue;
      }
      freshest = Math.min(freshest, age);
      records.push(Object.freeze({
        alias: this.#alias,
        operation,
        count: record.count,
        lastDurationMs: record.lastDurationMs,
        ageMs: Math.round(age),
        succeeded: record.succeeded,
        failed: record.failed,
        hits: record.hits,
        misses: record.misses,
        present: record.present,
        absent: record.absent,
        removed: record.removed,
        notRemoved: record.notRemoved,
      }));
    }
    let state: DiagnosticsInspectorState = 'no-data';
    if (records.length > 0) {
      state = freshest > CACHE_COLLECTOR_LIMITS.staleMs ? 'stale' : 'ready';
    }
    return Object.freeze({
      state,
      alias: this.#alias,
      coverage: 'owned-instance' as const,
      records: Object.freeze(records),
      dropped: 0,
    });
  }

  /** Latches `collection-failed` and discards every record. */
  #fail(): void {
    this.#failed = true;
    this.#records.clear();
    this.#cycle.clear();
  }
}

/**
 * The inert snapshot a disabled (or closed) source answers.
 *
 * @returns The frozen disabled snapshot
 * @internal
 */
export function disabledCacheSnapshot(): CacheDiagnosticsSnapshot {
  return Object.freeze({
    state: 'disabled' as const,
    alias: null,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped: 0,
  });
}

/** The value-free snapshot a failed collector answers. */
function failedSnapshot(alias: string): CacheDiagnosticsSnapshot {
  return Object.freeze({
    state: 'collection-failed' as const,
    alias,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped: 0,
  });
}

/**
 * Builds the source a CachePlugin instance registers. With no collector it
 * is the inert `disabled` source.
 *
 * @param collector - The instance's collector, or `null` when not opted in
 * @returns The source
 * @internal
 */
export function createCacheDiagnosticsSource(
  collector: CacheObservationCollector | null,
): ICacheDiagnosticsSource {
  return Object.freeze({
    snapshot: (): CacheDiagnosticsSnapshot =>
      collector === null ? disabledCacheSnapshot() : collector.snapshot(),
  });
}

/**
 * Runs one backend call under an attached collector. The caller receives a
 * promise derived from the backend's: it resolves to the same value, and
 * rejects with the ORIGINAL reason, so an unhandled backend rejection stays
 * unhandled exactly as without diagnostics. A synchronous backend throw is
 * recorded as `failed` and rethrown synchronously. The result is classified
 * into a primitive outcome before the collector sees it.
 *
 * @param collector - The service's attached collector
 * @param operation - The fixed backend operation
 * @param call - Invokes the backend
 * @returns What the backend returned
 * @internal
 */
export function observeCacheCall<T>(
  collector: CacheObservationCollector,
  operation: CacheDiagnosticsOperation,
  call: () => Promise<T>,
): Promise<T> {
  const start = collector.begin(operation);
  let pending: Promise<T>;
  try {
    pending = call();
  } catch (error) {
    collector.settle(operation, start, 'failed');
    throw error;
  }
  // Return a DERIVED promise that re-rejects with the original reason. A
  // side branch on the caller's own promise (`pending.then(ok, err)` while
  // returning `pending`) would be cheaper, but attaching a rejection handler
  // marks `pending` as handled: a fire-and-forget call whose backend rejects
  // would then stop surfacing as an unhandled rejection whenever diagnostics
  // are on, silently hiding an application error. Deriving costs one
  // microtask tick and promise identity; it keeps error visibility intact.
  return pending.then(
    (value) => {
      collector.settle(operation, start, classify(operation, value));
      return value;
    },
    (reason: unknown) => {
      collector.settle(operation, start, 'failed');
      throw reason;
    },
  );
}

/**
 * Classifies a fulfilled result into its primitive outcome. Reads only
 * `=== null` for `get` and `=== true` for `has`/`delete` — never the value.
 *
 * @param operation - The backend operation
 * @param value - The fulfilled result
 * @returns The outcome code
 */
function classify(operation: CacheDiagnosticsOperation, value: unknown): CacheCallOutcome {
  switch (operation) {
    case 'get':
      return value === null ? 'miss' : 'hit';
    case 'has':
      return value === true ? 'present' : 'absent';
    case 'delete':
      return value === true ? 'removed' : 'not-removed';
    default:
      return 'succeeded';
  }
}

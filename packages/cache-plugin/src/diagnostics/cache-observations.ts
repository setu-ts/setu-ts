/**
 * Opt-in cache operation counters (M98i) — the bounded collector behind
 * `CachePlugin({ diagnostics })` and the `ICacheDiagnosticsSource` every
 * CachePlugin instance registers under `CAPABILITIES.CACHE_DIAGNOSTICS`.
 *
 * INTERNAL: nothing here is exported from the package barrel. The collector
 * is attached to the plugin's OWN `CacheService` through a module-private
 * `WeakMap`, so the service's exported constructor is unchanged and a
 * service with no attachment runs exactly the pre-M98i code path — no clock
 * read, no label, no extra promise.
 *
 * What crosses into the collector is only a fixed operation name, a fixed
 * outcome code and two monotonic clock readings. Keys, prefixes, values,
 * factory results, TTLs and thrown values never do: the wrapper classifies
 * a result into a primitive detail code before calling the collector, and a
 * rejection is recorded as `failed` without the error ever being read.
 *
 * @module
 */
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
} as const;

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
  aliasControl: 'Cache diagnostics: an alias contains a control character.',
  extraKey: 'Cache diagnostics: options accept only enabled and alias.',
} as const;

/** The option keys the policy admits. */
const OPTION_KEYS: ReadonlySet<string> = new Set(['enabled', 'alias']);

const ENCODER = new TextEncoder();

/**
 * Reports whether a string carries a C0/C1 control code point.
 *
 * @param value - The string to scan
 * @returns `true` when any code point is in U+0000–U+001F or U+007F–U+009F
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

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
  if (hasControlCharacter(alias)) {
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
  lastDurationMs: number;
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
   * Reads the start time of a call, or `null` when capture has stopped or
   * the clock threw (which latches `collection-failed`).
   *
   * @returns The monotonic start reading, or `null`
   */
  begin(): number | null {
    if (this.#failed || this.#closed) {
      return null;
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
   * @param start - The reading {@linkcode begin} returned; `null` skips the call
   * @param outcome - The primitive classification of the call
   */
  settle(
    operation: CacheDiagnosticsOperation,
    start: number | null,
    outcome: CacheCallOutcome,
  ): void {
    if (start === null || this.#failed || this.#closed) {
      return;
    }
    try {
      const now = this.#clock();
      const duration = Math.round(Math.max(0, now - start));
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
          lastDurationMs: 0,
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
      record.lastDurationMs = duration;
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

/** Service → collector. Module-private: only this module attaches or reads. */
const ATTACHMENTS = new WeakMap<object, CacheObservationCollector>();

/**
 * Attaches a collector to the plugin's own service.
 *
 * @param service - The owned `CacheService`
 * @param collector - Its collector
 * @internal
 */
export function attachCacheCollector(service: object, collector: CacheObservationCollector): void {
  ATTACHMENTS.set(service, collector);
}

/**
 * Detaches a service's collector. Close detaches FIRST, then clears the
 * collector.
 *
 * @param service - The owned `CacheService`
 * @internal
 */
export function detachCacheCollector(service: object): void {
  ATTACHMENTS.delete(service);
}

/**
 * Runs one backend call, observing it when (and only when) a collector is
 * attached to `service`. Without an attachment the call runs exactly as
 * before: the returned value is the backend's own promise and a synchronous
 * throw propagates synchronously. With one, the result is classified into a
 * primitive outcome and the ORIGINAL value or rejection reason is passed
 * through unchanged; a synchronous backend throw is recorded as `failed` and
 * rethrown synchronously.
 *
 * @param service - The owning `CacheService`
 * @param operation - The fixed backend operation
 * @param call - Invokes the backend
 * @returns What the backend returned (observed or not)
 * @internal
 */
export function observeCacheCall<T>(
  service: object,
  operation: CacheDiagnosticsOperation,
  call: () => Promise<T>,
): Promise<T> {
  const collector = ATTACHMENTS.get(service);
  if (collector === undefined) {
    return call();
  }
  const start = collector.begin();
  let pending: Promise<T>;
  try {
    pending = call();
  } catch (error) {
    collector.settle(operation, start, 'failed');
    throw error;
  }
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

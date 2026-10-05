/**
 * Opt-in storage operation observations (M98m) — the bounded collector behind
 * `StoragePlugin({ diagnostics })` and the `IStorageDiagnosticsSource` every
 * StoragePlugin instance registers under `CAPABILITIES.STORAGE_DIAGNOSTICS`.
 *
 * INTERNAL: nothing here is exported from the package barrel. The collector
 * is attached to the plugin's OWN `StorageService` through the
 * non-barrel-exported `attachStorageCollector` in `storage-service.ts`, so
 * the service's exported constructor is unchanged and a service with no
 * collector does one WeakMap read beyond the pre-M98m code path — no clock
 * read, no extra promise, no allocation.
 *
 * What crosses into the collector is only a fixed operation name, a fixed
 * outcome code, at most two monotonic clock readings and, for a successful
 * buffered `put`/`get`, the byte LENGTH read through the intrinsic
 * typed-array accessor before or after the provider call. Paths, bytes,
 * metadata, content types, signed URLs, credentials and thrown values never
 * do: a rejection is recorded as `failed` without the error ever being read,
 * and a signed URL is returned to the caller without being inspected.
 *
 * @module
 */
import { hasForbiddenAliasCharacter } from '@setu-ts/common';
import type {
  DiagnosticsInspectorState,
  IStorageDiagnosticsSource,
  StorageDiagnosticsOperation,
  StorageDiagnosticsRecord,
  StorageDiagnosticsSnapshot,
} from '@setu-ts/common';
import type { StorageDiagnosticsOptions } from '../interfaces/index.ts';

/**
 * The fixed collector bounds. Constants, not options.
 *
 * @internal
 */
export const STORAGE_COLLECTOR_LIMITS = {
  /** Maximum UTF-8 bytes of the approved alias. */
  aliasBytes: 64,
  /** A record idle for this long (ms since its last settlement) is expired and cleared. */
  retentionMs: 60_000,
  /** A snapshot whose freshest record is older than this (ms) is `stale`. */
  staleMs: 30_000,
  /**
   * The maximum concurrently in-flight observed calls per source. A call
   * beyond the cap runs normally but unobserved, incrementing the
   * saturating `dropped` once — without a start clock read or an observation
   * callback. The cap bounds diagnostic state, not application concurrency:
   * nothing is queued, cancelled or timed out to enforce it.
   */
  maxActiveTokens: 1_024,
} as const;

/**
 * The fixed, value-free refusal messages. None echoes a supplied value.
 *
 * @internal
 */
export const STORAGE_DIAGNOSTICS_ERRORS = {
  shape: 'Storage diagnostics: options must be an object { enabled: true, alias }.',
  enabled: 'Storage diagnostics: enabled must be the literal true; omit diagnostics instead.',
  aliasType: 'Storage diagnostics: alias must be a string.',
  aliasBytes: 'Storage diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Storage diagnostics: an alias contains a control character.',
  extraKey: 'Storage diagnostics: options accept only enabled and alias.',
} as const;

/** The option keys the policy admits. */
const OPTION_KEYS: ReadonlySet<string> = new Set(['enabled', 'alias']);

const ENCODER = new TextEncoder();

/**
 * Validates the storage-diagnostics options and returns the approved alias.
 * The ONE validation of these options: the plugin factory calls it when
 * `StoragePlugin(...)` is called, so an invalid option refuses before any
 * application exists. `enabled` is checked at runtime, not only by its
 * literal type, so a configuration-driven `enabled: false` is refused
 * rather than silently opted in.
 *
 * @param options - The supplied options
 * @returns The approved display alias
 * @throws {TypeError | RangeError} With a fixed, value-free message
 * @internal
 */
export function compileStorageDiagnosticsAlias(options: StorageDiagnosticsOptions): string {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(STORAGE_DIAGNOSTICS_ERRORS.shape);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(STORAGE_DIAGNOSTICS_ERRORS.extraKey);
    }
  }
  if (options.enabled !== true) {
    throw new TypeError(STORAGE_DIAGNOSTICS_ERRORS.enabled);
  }
  const alias: unknown = options.alias;
  if (typeof alias !== 'string') {
    throw new TypeError(STORAGE_DIAGNOSTICS_ERRORS.aliasType);
  }
  const bytes = ENCODER.encode(alias).length;
  if (bytes < 1 || bytes > STORAGE_COLLECTOR_LIMITS.aliasBytes) {
    throw new RangeError(STORAGE_DIAGNOSTICS_ERRORS.aliasBytes);
  }
  if (hasForbiddenAliasCharacter(alias)) {
    throw new RangeError(STORAGE_DIAGNOSTICS_ERRORS.aliasControl);
  }
  return alias;
}

/** The primitive settlement of one observed service operation. */
export type StorageCallOutcome = 'failed' | 'succeeded';

/** The mutable counters behind one record. */
interface MutableRecord {
  count: number;
  succeeded: number;
  failed: number;
  lastDurationMs: number | null;
  lastBytes: number | null;
  lastAt: number;
}

/** The fixed operation order records are reported in. */
const OPERATIONS: readonly StorageDiagnosticsOperation[] = [
  'put',
  'get',
  'delete',
  'exists',
  'getSignedUrl',
  'getStream',
];

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
 * The bounded collector for one StoragePlugin instance. At most one record
 * per fixed operation for its one approved alias (six in all), so the record
 * set is bounded by construction. `dropped` counts the calls that ran
 * unobserved because the active-token cap was full; it is source-lifetime
 * cumulative until close, not reset on record expiry.
 *
 * Every entry point catches its own failures: a throwing or non-finite clock
 * (or any internal fault) latches `collection-failed`, clears the records and
 * stops capture until the plugin instance is recreated. Nothing it does can
 * change an application result or error.
 *
 * @internal
 */
export class StorageObservationCollector {
  readonly #alias: string;
  readonly #clock: () => number;
  readonly #records = new Map<StorageDiagnosticsOperation, MutableRecord>();
  /** Concurrently in-flight observed calls; released on settlement. */
  #active = 0;
  /** Source-lifetime count of calls that ran unobserved for want of a token. */
  #dropped = 0;
  /** The last accepted clock reading; backward movement is clamped to it. */
  #lastAccepted = 0;
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
   * Marks the start of a call. A call beyond the active-token cap is NOT
   * observed: it runs normally, `dropped` increments once (saturating), and
   * no start clock is read. A clock fault latches `collection-failed`.
   *
   * @returns The monotonic start reading, or `null` when the call runs
   * unobserved (cap, stopped capture, or a clock fault)
   */
  begin(): number | null {
    if (this.#failed || this.#closed) {
      return null;
    }
    if (this.#active >= STORAGE_COLLECTOR_LIMITS.maxActiveTokens) {
      this.#dropped = bump(this.#dropped);
      return null;
    }
    this.#active++;
    try {
      const reading = this.#clock();
      if (!Number.isFinite(reading)) {
        this.#fail();
        return null;
      }
      const start = Math.max(reading, this.#lastAccepted);
      this.#lastAccepted = start;
      return start;
    } catch {
      this.#active--;
      this.#fail();
      return null;
    }
  }

  /**
   * Records one settled service operation. The token is released FIRST, so a
   * hung call can retain at most the cap and an observer failure can never
   * leak a token.
   *
   * @param operation - The fixed service operation
   * @param start - What {@linkcode begin} returned; `null` skips the call
   * @param outcome - The primitive settlement
   * @param bytes - For a successful `put`/`get`, the intrinsic byte length of
   * the application argument/result; `null` everywhere else
   */
  settle(
    operation: StorageDiagnosticsOperation,
    start: number | null,
    outcome: StorageCallOutcome,
    bytes: number | null,
  ): void {
    if (start === null || this.#failed || this.#closed) {
      return;
    }
    this.#active--;
    try {
      const reading = this.#clock();
      if (!Number.isFinite(reading)) {
        this.#fail();
        return;
      }
      const now = Math.max(reading, this.#lastAccepted);
      this.#lastAccepted = now;
      let record = this.#records.get(operation);
      if (record === undefined || now - record.lastAt >= STORAGE_COLLECTOR_LIMITS.retentionMs) {
        // Expired (or fresh): the counters are cleared before this settlement
        // is recorded, so a long-running call never resurrects an expired
        // counter.
        record = {
          count: 0,
          succeeded: 0,
          failed: 0,
          lastDurationMs: null,
          lastBytes: null,
          lastAt: now,
        };
        this.#records.set(operation, record);
      }
      record.count = bump(record.count);
      if (outcome === 'failed') {
        record.failed = bump(record.failed);
        record.lastBytes = null;
      } else {
        record.succeeded = bump(record.succeeded);
        record.lastBytes = bytes;
      }
      // getSignedUrl records outcome and age only — never a duration.
      // Clamped to MAX_SAFE_INTEGER like every other number: a finite but
      // enormous clock jump must not store a duration the wire validator
      // refuses, which would report the whole source collection-failed.
      if (operation !== 'getSignedUrl') {
        record.lastDurationMs = Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.round(Math.max(0, now - start)),
        );
      }
      record.lastAt = now;
    } catch {
      this.#fail();
    }
  }

  /**
   * Marks the collector closed and clears every record. Late settlements are
   * ignored and cannot repopulate it.
   */
  close(): void {
    this.#closed = true;
    this.#records.clear();
    this.#active = 0;
  }

  /**
   * Builds the frozen snapshot. Expired records are cleared first.
   *
   * @returns The deeply frozen snapshot
   */
  snapshot(): StorageDiagnosticsSnapshot {
    if (this.#closed) {
      return disabledStorageSnapshot();
    }
    if (this.#failed) {
      return failedStorageSnapshot(this.#alias, this.#dropped);
    }
    let now: number;
    try {
      const reading = this.#clock();
      if (!Number.isFinite(reading)) {
        this.#fail();
        return failedStorageSnapshot(this.#alias, this.#dropped);
      }
      now = Math.max(reading, this.#lastAccepted);
    } catch {
      this.#fail();
      return failedStorageSnapshot(this.#alias, this.#dropped);
    }
    const records: StorageDiagnosticsRecord[] = [];
    let freshest = Number.POSITIVE_INFINITY;
    for (const operation of OPERATIONS) {
      const record = this.#records.get(operation);
      if (record === undefined) {
        continue;
      }
      // Rounded ONCE, before both comparisons, so the reported `ageMs`, the
      // expiry decision and the stale decision all read the same integer —
      // the wire validator re-derives the state from `ageMs`.
      const age = Math.round(Math.max(0, now - record.lastAt));
      if (age >= STORAGE_COLLECTOR_LIMITS.retentionMs) {
        this.#records.delete(operation);
        continue;
      }
      freshest = Math.min(freshest, age);
      records.push(Object.freeze({
        alias: this.#alias,
        operation,
        count: record.count,
        lastDurationMs: record.lastDurationMs,
        ageMs: age,
        succeeded: record.succeeded,
        failed: record.failed,
        lastBytes: record.lastBytes,
      }));
    }
    let state: DiagnosticsInspectorState = 'no-data';
    if (records.length > 0) {
      state = freshest > STORAGE_COLLECTOR_LIMITS.staleMs ? 'stale' : 'ready';
    }
    return Object.freeze({
      state,
      alias: this.#alias,
      coverage: 'owned-instance' as const,
      records: Object.freeze(records),
      dropped: this.#dropped,
    });
  }

  /** Latches `collection-failed` and discards every record. */
  #fail(): void {
    this.#failed = true;
    this.#records.clear();
    this.#active = 0;
  }
}

/**
 * The inert snapshot a disabled (or closed) source answers.
 *
 * @returns The frozen disabled snapshot
 * @internal
 */
export function disabledStorageSnapshot(): StorageDiagnosticsSnapshot {
  return Object.freeze({
    state: 'disabled' as const,
    alias: null,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped: 0,
  });
}

/**
 * The value-free snapshot a failed collector answers. `dropped` is kept:
 * it is source-lifetime cumulative until close, and a collection fault is
 * not a close.
 */
function failedStorageSnapshot(alias: string, dropped: number): StorageDiagnosticsSnapshot {
  return Object.freeze({
    state: 'collection-failed' as const,
    alias,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped,
  });
}

/**
 * Builds the source a StoragePlugin instance registers. With no collector it
 * is the inert `disabled` source.
 *
 * @param collector - The instance's collector, or `null` when not opted in
 * @returns The frozen snapshot-only facade
 * @internal
 */
export function createStorageDiagnosticsSource(
  collector: StorageObservationCollector | null,
): IStorageDiagnosticsSource {
  return Object.freeze({
    snapshot: (): StorageDiagnosticsSnapshot =>
      collector === null ? disabledStorageSnapshot() : collector.snapshot(),
  });
}

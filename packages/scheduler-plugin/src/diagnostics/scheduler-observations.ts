/**
 * Opt-in scheduler execution observations (M98k) — the bounded collector
 * behind `SchedulerPlugin({ diagnostics })` and the
 * `ISchedulerDiagnosticsSource` every SchedulerPlugin instance registers
 * under `CAPABILITIES.SCHEDULER_DIAGNOSTICS`.
 *
 * INTERNAL: nothing here is exported from the package barrel except through
 * the plugin's own wiring. The collector is attached to the plugin's OWN
 * `SchedulerService` through the internal `attachSchedulerCollector` helper
 * in `scheduler-service.ts`, so the service's exported constructor is
 * unchanged and an unattached service runs exactly the pre-M98k path — one
 * field read beyond it, no clock read, no label, no allocation.
 *
 * What crosses into the collector is only the fixed observation kind, a
 * fixed outcome code and at most three monotonic or wall readings. Job
 * names resolve to approved aliases at the observation boundary and the raw
 * name never enters a record; cron expressions, payloads, lock keys and
 * tokens, and thrown values never cross at all. A skipped local fire is
 * recorded as contended or lock-failed — never as a globally missed
 * execution, for which no counter exists.
 *
 * @module
 */
import type {
  ISchedulerDiagnosticsSource,
  SchedulerDiagnosticsOperation,
  SchedulerDiagnosticsRecord,
  SchedulerDiagnosticsSnapshot,
} from '@setu-ts/common';
import type { SchedulerDiagnosticsOptions } from '../interfaces/index.ts';

/**
 * The fixed collector bounds. Constants, not options.
 *
 * @internal
 */
export const SCHEDULER_COLLECTOR_LIMITS = {
  /** Maximum UTF-8 bytes of any approved alias (source or job). */
  aliasBytes: 64,
  /** Exact job names the jobs map may approve. */
  maxJobs: 64,
  /** (job alias, operation) record tuples one source retains. */
  maxRecords: 64,
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
export const SCHEDULER_DIAGNOSTICS_ERRORS = {
  shape: 'Scheduler diagnostics: options must be an object { enabled: true, alias, jobs }.',
  enabled: 'Scheduler diagnostics: enabled must be the literal true; omit diagnostics instead.',
  aliasType: 'Scheduler diagnostics: alias must be a string.',
  aliasBytes: 'Scheduler diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Scheduler diagnostics: an alias contains a control character.',
  jobsRequired: 'Scheduler diagnostics: jobs is required when diagnostics is enabled.',
  jobsShape: 'Scheduler diagnostics: jobs must be a plain object mapping job names to aliases.',
  jobsCount: 'Scheduler diagnostics: jobs approves at most 64 entries.',
  jobsValue: 'Scheduler diagnostics: every jobs entry must be an approved alias string.',
  jobsDuplicate: 'Scheduler diagnostics: job aliases must be unique within jobs.',
} as const;

/** The option keys the policy admits. */
const OPTION_KEYS: ReadonlySet<string> = new Set(['enabled', 'alias', 'jobs']);

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
 * Validates one approved alias: a string of 1–64 UTF-8 bytes with no
 * control character. "Safe" is a SHAPE, not secret detection — approving an
 * alias IS authorizing its disclosure; never derive one from a job name,
 * cron expression or payload.
 *
 * @param value - The candidate alias
 * @param typeMessage - The fixed message for a non-string value
 * @returns The validated alias
 * @throws {TypeError | RangeError} With a fixed, value-free message
 */
function approvedAlias(value: unknown, typeMessage: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(typeMessage);
  }
  const bytes = ENCODER.encode(value).length;
  if (bytes < 1 || bytes > SCHEDULER_COLLECTOR_LIMITS.aliasBytes) {
    throw new RangeError(SCHEDULER_DIAGNOSTICS_ERRORS.aliasBytes);
  }
  if (hasControlCharacter(value)) {
    throw new RangeError(SCHEDULER_DIAGNOSTICS_ERRORS.aliasControl);
  }
  return value;
}

/**
 * The validated `diagnostics` option of one SchedulerPlugin instance: the
 * approved source alias and the exact job-name → job-alias approvals.
 *
 * @since 0.8.0
 */
export interface CompiledSchedulerDiagnostics {
  /** The approved display alias of this source. */
  readonly alias: string;
  /** Exact job names approved for observation, mapped to their aliases. */
  readonly jobs: ReadonlyMap<string, string>;
}

/**
 * Validates the scheduler-diagnostics options. The ONE validation of these
 * options: the plugin factory calls it when `SchedulerPlugin(...)` is
 * called, so an invalid option refuses before any application exists.
 * `enabled` is checked at runtime, not only by its literal type; `jobs` is
 * REQUIRED — an empty map approves no observations, and is distinct from
 * omitting `diagnostics` (which registers an inert disabled source).
 * Lookups use own entries only, never inherited properties.
 *
 * @param options - The supplied options
 * @returns The compiled approvals
 * @throws {TypeError | RangeError} With a fixed, value-free message
 * @internal
 */
export function compileSchedulerDiagnostics(
  options: SchedulerDiagnosticsOptions,
): CompiledSchedulerDiagnostics {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.shape);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.shape);
    }
  }
  if (options.enabled !== true) {
    throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.enabled);
  }
  const alias = approvedAlias(options.alias, SCHEDULER_DIAGNOSTICS_ERRORS.aliasType);
  // A jobs key that is ABSENT is a different mistake from one that is not a
  // plain object, so each has its own fixed message.
  if (!Object.hasOwn(options, 'jobs')) {
    throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.jobsRequired);
  }
  const jobs: unknown = options.jobs;
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) {
    throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.jobsShape);
  }
  const prototype = Object.getPrototypeOf(jobs);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(SCHEDULER_DIAGNOSTICS_ERRORS.jobsShape);
  }
  const names = Object.keys(jobs as Readonly<Record<string, string>>);
  if (names.length > SCHEDULER_COLLECTOR_LIMITS.maxJobs) {
    throw new RangeError(SCHEDULER_DIAGNOSTICS_ERRORS.jobsCount);
  }
  const approvals = new Map<string, string>();
  const seenAliases = new Set<string>();
  for (const name of names) {
    const jobAlias = approvedAlias(
      (jobs as Readonly<Record<string, unknown>>)[name],
      SCHEDULER_DIAGNOSTICS_ERRORS.jobsValue,
    );
    if (seenAliases.has(jobAlias)) {
      throw new RangeError(SCHEDULER_DIAGNOSTICS_ERRORS.jobsDuplicate);
    }
    seenAliases.add(jobAlias);
    approvals.set(name, jobAlias);
  }
  return { alias, jobs: approvals };
}

/**
 * The fixed outcome of one observed fire's skip-or-dispatch decision.
 *
 * `dispatched` — the fire slot was this replica's AND the handler mutex was
 * acquired, so the dispatch ran. `contended` — a lock was held elsewhere:
 * the fire slot claimed by another replica, a delay whose registration slot
 * this replica never held, or the overlap mutex held by a previous fire.
 * `lock-failed` — a lock operation rejected while deciding, so the fire was
 * skipped rather than risk a duplicate run.
 *
 * @internal
 */
export type SchedulerFireOutcome = 'dispatched' | 'contended' | 'lock-failed';

/**
 * One fire observed at its timer callback: the lateness measured there,
 * carried to the settle call. Opaque to the caller.
 *
 * @internal
 */
export interface FireObservation {
  /** The approved job alias resolved at the observation boundary. */
  readonly jobAlias: string;
  /** `max(0, actualStart - intendedFire)` in wall-clock ms. */
  readonly latenessMs: number;
}

/**
 * One handler attempt of the executor, observed by the dispatch that started
 * it. The methods the executor calls; every implementation is supplied by
 * the collector and catches its own failures.
 *
 * @internal
 */
export interface SchedulerAttemptObserver {
  /** One attempt began: its handler is about to be invoked. Reads the collector's clock. */
  attemptStarted(): void;
  /**
   * One attempt settled. The duration is measured by the observer itself,
   * from its own start reading, so the executor reads no clock.
   *
   * @param succeeded - Whether the handler fulfilled
   * @param isRetry - Whether the attempt was numbered above the first
   */
  attemptSettled(succeeded: boolean, isRetry: boolean): void;
}

/** The mutable counters behind one (job alias, operation) tuple. */
interface MutableRecord {
  /** The approved job alias this tuple counts (part of its key). */
  alias: string;
  /** The observation this tuple counts (part of its key). */
  operation: SchedulerDiagnosticsOperation;
  count: number;
  started: number;
  succeeded: number;
  failed: number;
  contended: number;
  lockFailed: number;
  retryAttempts: number;
  lastDurationMs: number | null;
  lastLatenessMs: number;
  lastAt: number;
}

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
 * Normalizes a measured millisecond value to the wire's non-negative safe
 * integer: rounded, clamped at zero and at `Number.MAX_SAFE_INTEGER`, and a
 * non-finite reading becomes `0`. A fractional reading is ordinary — a
 * `delay(name, 20.5)` or `every(name, 100.5)` job is armed for a fractional
 * instant — and the connector refuses any non-integer counter, so an
 * unrounded value would turn the WHOLE source `collection-failed`.
 *
 * @param value - The measured milliseconds
 * @returns The wire-safe integer milliseconds
 * @internal
 */
export function toWireMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

/**
 * The bounded collector for one SchedulerPlugin instance. At most
 * {@linkcode SCHEDULER_COLLECTOR_LIMITS.maxRecords} (job alias, operation)
 * tuples are retained; a NEW tuple with no free slot is ignored and counted
 * in the saturating `dropped`, while existing tuples always continue
 * updating.
 *
 * Every entry point catches its own failures: a throwing clock (or any
 * internal fault) latches `collection-failed`, clears the records and stops
 * capture until the plugin instance is recreated. Nothing it does can
 * change a fire's outcome, a handler's result, or a thrown error.
 *
 * @internal
 */
export class SchedulerObservationCollector {
  readonly #alias: string;
  readonly #jobs: ReadonlyMap<string, string>;
  /** The runtime's wall clock (`runtime.now`, epoch ms) — fire lateness only. */
  readonly #wall: () => number;
  /** The runtime's monotonic clock (`runtime.hrtime`) — durations and ages. */
  readonly #mono: () => number;
  readonly #records = new Map<string, MutableRecord>();
  #dropped = 0;
  #failed = false;
  #closed = false;

  /**
   * @param alias - The approved display alias of this source
   * @param jobs - The approved job-name → job-alias map
   * @param wall - The runtime's wall clock, for intended-vs-actual fire times
   * @param mono - The runtime's monotonic clock, for durations and ages
   */
  constructor(
    alias: string,
    jobs: ReadonlyMap<string, string>,
    wall: () => number,
    mono: () => number,
  ) {
    this.#alias = alias;
    this.#jobs = jobs;
    this.#wall = wall;
    this.#mono = mono;
  }

  /**
   * Observes one timer fire at its callback entry: resolves the approved
   * alias and measures `max(0, actualStart - intendedFire)` from the wall
   * clock. Reads no other clock and records nothing yet — the fire is
   * settled by {@linkcode fireSettled}.
   *
   * @param name - The exact job name of the firing entry
   * @param intendedFireMs - The epoch ms the fire was armed for
   * @returns The carried observation, or `null` when the job was not
   * approved or capture has stopped (never an application-visible signal)
   */
  fireBegin(name: string, intendedFireMs: number): FireObservation | null {
    if (this.#failed || this.#closed) {
      return null;
    }
    const jobAlias = this.#jobs.get(name);
    if (jobAlias === undefined) {
      return null;
    }
    try {
      return { jobAlias, latenessMs: toWireMs(this.#wall() - intendedFireMs) };
    } catch {
      this.#fail();
      return null;
    }
  }

  /**
   * Settles one observed fire: counts it and its decision outcome, and —
   * when the fire dispatched — its dispatch result and duration.
   *
   * @param observation - What {@linkcode fireBegin} returned; `null` skips
   * @param outcome - The skip-or-dispatch decision
   * @param dispatchSucceeded - Whether the dispatch settled fulfilled; only
   * meaningful with `outcome: 'dispatched'`
   * @param dispatchDurationMs - Integer monotonic ms of the dispatch, or
   * `null` when it was not measured
   */
  fireSettled(
    observation: FireObservation | null,
    outcome: SchedulerFireOutcome,
    dispatchSucceeded: boolean | null,
    dispatchDurationMs: number | null,
  ): void {
    if (observation === null || this.#failed || this.#closed) {
      return;
    }
    try {
      const now = this.#mono();
      const record = this.#tuple(observation.jobAlias, 'fire', now, true);
      if (record === null) {
        return;
      }
      record.count = bump(record.count);
      record.lastLatenessMs = observation.latenessMs;
      if (outcome === 'dispatched') {
        record.started = bump(record.started);
        if (dispatchSucceeded === true) {
          record.succeeded = bump(record.succeeded);
        } else {
          record.failed = bump(record.failed);
        }
        if (dispatchDurationMs !== null) {
          record.lastDurationMs = toWireMs(dispatchDurationMs);
        }
      } else if (outcome === 'contended') {
        record.contended = bump(record.contended);
      } else {
        record.lockFailed = bump(record.lockFailed);
      }
      record.lastAt = now;
    } catch {
      this.#fail();
    }
  }

  /**
   * One guarded monotonic reading for the service's dispatch timing. The
   * service never reads the runtime clock itself on the observed path: a
   * throwing clock here latches `collection-failed` and answers `null`, so
   * it can neither skip a lock release nor fail a dispatch.
   *
   * @returns The reading, or `null` when capture has stopped or the clock threw
   */
  monotonic(): number | null {
    if (this.#failed || this.#closed) {
      return null;
    }
    try {
      return this.#mono();
    } catch {
      this.#fail();
      return null;
    }
  }

  /**
   * The integer monotonic milliseconds since a {@linkcode monotonic}
   * reading, through the same guard.
   *
   * @param start - The earlier reading, or `null` when none was taken
   * @returns The elapsed milliseconds, or `null` when not measurable
   */
  elapsedSince(start: number | null): number | null {
    if (start === null) {
      return null;
    }
    const now = this.monotonic();
    return now === null ? null : toWireMs(now - start);
  }

  /**
   * Builds the observer the executor calls for one dispatched fire's
   * handler attempts. `null` when the job was not approved — an unobserved
   * dispatch allocates nothing and reads no clock.
   *
   * The observer measures each attempt itself, through the collector's
   * guarded clock, so the executor reads no clock on the observed path. It
   * also carries the record its start was counted in: when the settlement
   * lands in a DIFFERENT record — the original expired and was replaced
   * while the handler ran, or the start was refused at capacity — the
   * start is counted there too, so `started` never falls below `count`.
   *
   * @param name - The exact job name of the dispatch
   * @returns The observer, or `null` when unobserved
   */
  attemptObserver(name: string): SchedulerAttemptObserver | null {
    if (this.#failed || this.#closed) {
      return null;
    }
    const jobAlias = this.#jobs.get(name);
    if (jobAlias === undefined) {
      return null;
    }
    // The record the current attempt's start was counted in (`null` when it
    // was refused at capacity; `undefined` before any start), and the
    // monotonic reading it started at.
    let origin: MutableRecord | null | undefined;
    let startedAt: number | null = null;
    return {
      attemptStarted: () => {
        if (this.#failed || this.#closed) {
          return;
        }
        try {
          const now = this.#mono();
          startedAt = now;
          // A refused start is not a drop by itself: its settlement counts
          // the one ignored observation.
          origin = this.#tuple(jobAlias, 'attempt', now, false);
          if (origin !== null) {
            origin.started = bump(origin.started);
            origin.lastAt = now;
          }
        } catch {
          this.#fail();
        }
      },
      attemptSettled: (succeeded, isRetry) => {
        if (this.#failed || this.#closed) {
          return;
        }
        try {
          const now = this.#mono();
          const record = this.#tuple(jobAlias, 'attempt', now, true);
          if (record !== null) {
            if (origin !== record) {
              record.started = bump(record.started);
            }
            record.count = bump(record.count);
            if (succeeded) {
              record.succeeded = bump(record.succeeded);
            } else {
              record.failed = bump(record.failed);
            }
            if (isRetry) {
              record.retryAttempts = bump(record.retryAttempts);
            }
            if (startedAt !== null) {
              record.lastDurationMs = toWireMs(now - startedAt);
            }
            record.lastAt = now;
          }
          origin = undefined;
          startedAt = null;
        } catch {
          this.#fail();
        }
      },
    };
  }

  /**
   * Resolves the mutable record for one (job alias, operation) tuple. An
   * existing tuple past retention is REPLACED by a fresh record (a new
   * identity, so an attempt observer can tell its start was not counted
   * there). A NEW tuple with no free slot first reclaims every expired
   * slot — otherwise slots nobody has read since they expired would refuse
   * live work — and only then is refused: `null`, counting the saturating
   * `dropped` when `countDrop`.
   */
  #tuple(
    jobAlias: string,
    operation: SchedulerDiagnosticsOperation,
    now: number,
    countDrop: boolean,
  ): MutableRecord | null {
    const key = `${jobAlias}\u0000${operation}`;
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (now - existing.lastAt > SCHEDULER_COLLECTOR_LIMITS.retentionMs) {
        // Expired without an observation: clear its counters, keep the slot.
        const fresh = this.#freshRecord(jobAlias, operation, now);
        this.#records.set(key, fresh);
        return fresh;
      }
      return existing;
    }
    if (this.#records.size >= SCHEDULER_COLLECTOR_LIMITS.maxRecords) {
      this.#expire(now);
    }
    if (this.#records.size >= SCHEDULER_COLLECTOR_LIMITS.maxRecords) {
      if (countDrop) {
        this.#dropped = bump(this.#dropped);
      }
      return null;
    }
    const record = this.#freshRecord(jobAlias, operation, now);
    this.#records.set(key, record);
    return record;
  }

  /**
   * Deletes every record older than the retention window. Checked during
   * update (at capacity) and read — never by a background timer.
   */
  #expire(now: number): void {
    for (const [key, record] of this.#records) {
      if (now - record.lastAt > SCHEDULER_COLLECTOR_LIMITS.retentionMs) {
        this.#records.delete(key);
      }
    }
  }

  /**
   * A zeroed record stamped `lastAt: now`, carrying the identity its key
   * names so projection never has to reverse-lookup the map.
   */
  #freshRecord(
    jobAlias: string,
    operation: SchedulerDiagnosticsOperation,
    now: number,
  ): MutableRecord {
    return {
      alias: jobAlias,
      operation,
      count: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      contended: 0,
      lockFailed: 0,
      retryAttempts: 0,
      lastDurationMs: null,
      lastLatenessMs: 0,
      lastAt: now,
    };
  }

  /**
   * Marks the collector closed and clears every record. Late observations
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
  snapshot(): SchedulerDiagnosticsSnapshot {
    if (this.#closed) {
      return disabledSchedulerSnapshot();
    }
    if (this.#failed) {
      return failedSchedulerSnapshot(this.#alias);
    }
    let now: number;
    try {
      now = this.#mono();
    } catch {
      this.#fail();
      return failedSchedulerSnapshot(this.#alias);
    }
    const records: SchedulerDiagnosticsRecord[] = [];
    let freshest = Number.POSITIVE_INFINITY;
    for (const record of this.#records.values()) {
      const age = Math.max(0, now - record.lastAt);
      if (age > SCHEDULER_COLLECTOR_LIMITS.retentionMs) {
        // Expired during read: dropped, not served.
        continue;
      }
      freshest = Math.min(freshest, age);
      records.push(Object.freeze({
        alias: record.alias,
        operation: record.operation,
        count: record.count,
        lastDurationMs: record.lastDurationMs,
        ageMs: Math.round(age),
        started: record.started,
        succeeded: record.succeeded,
        failed: record.failed,
        contended: record.contended,
        lockFailed: record.lockFailed,
        retryAttempts: record.retryAttempts,
        lastLatenessMs: record.lastLatenessMs,
      }));
    }
    // Records whose slot expired during this read are removed after the
    // walk that built the projection.
    this.#expire(now);
    let state: 'no-data' | 'ready' | 'stale';
    if (records.length === 0) {
      state = 'no-data';
    } else {
      state = freshest > SCHEDULER_COLLECTOR_LIMITS.staleMs ? 'stale' : 'ready';
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
  }
}

/**
 * The inert snapshot a disabled (or closed) source answers.
 *
 * @returns The frozen disabled snapshot
 * @internal
 */
export function disabledSchedulerSnapshot(): SchedulerDiagnosticsSnapshot {
  return Object.freeze({
    state: 'disabled' as const,
    alias: null,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped: 0,
  });
}

/** The value-free snapshot a failed collector answers. */
function failedSchedulerSnapshot(alias: string): SchedulerDiagnosticsSnapshot {
  return Object.freeze({
    state: 'collection-failed' as const,
    alias,
    coverage: 'owned-instance' as const,
    records: Object.freeze([]),
    dropped: 0,
  });
}

/**
 * Builds the source a SchedulerPlugin instance registers. With no collector
 * it is the inert `disabled` source.
 *
 * @param collector - The instance's collector, or `null` when not opted in
 * @returns The source
 * @internal
 */
export function createSchedulerDiagnosticsSource(
  collector: SchedulerObservationCollector | null,
): ISchedulerDiagnosticsSource {
  return Object.freeze({
    snapshot: (): SchedulerDiagnosticsSnapshot =>
      collector === null ? disabledSchedulerSnapshot() : collector.snapshot(),
  });
}

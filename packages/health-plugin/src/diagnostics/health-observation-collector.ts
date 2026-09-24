/**
 * Health observation collector (M98d) — the health-plugin-owned, latest-only
 * retention and bounded scheduler behind `IHealthDiagnosticsSource`.
 *
 * The collector is the minimization seam. It accepts only framework-owned
 * primitives — the fixed observation state, the status (only when reported,
 * and only one of `up`/`degraded`/`down`), the measured latency, and the
 * registered name used for an exact alias lookup — and never an indicator's
 * `data`, a thrown value, an unrecognized status string, or an absolute time.
 * It retains ONE frozen observation per approved alias, never a history, so
 * memory stays constant under sustained input.
 *
 * A separately-controlled scheduler, enabled only when `options.scheduled` is
 * present, runs bounded cycles of approved indicators. A timeout is a
 * REPORTING bound, not a cancellation: a check that has not settled within
 * `timeoutMs` is reported as `timed-out`, but its raw callback remains marked
 * in-flight until it actually settles, so no replacement check for it starts
 * early and a hung callback cannot accumulate work. The in-flight callback
 * keeps its concurrency slot, and ONLY that slot: a cycle waits for each
 * check's reporting race, never for a raw callback, so while fewer than
 * `concurrency` callbacks are hung the other scheduled indicators keep
 * refreshing. Once every slot is held by a hung callback, NO scheduled check
 * starts until one settles: the work stays bounded, and the stalled aliases
 * surface as `stale` or `never-observed` rather than as fresh data. Each
 * cycle covers every scheduled indicator not still in flight, starting from
 * a rotating cursor so none is starved.
 * Closing the collector marks it closed FIRST (so a late settlement is
 * discarded), then clears the interval, every armed deadline timer, and every
 * retained observation — M98a's own teardown order.
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthDiagnosticsObservation,
  HealthDiagnosticsSnapshot,
  HealthObservationState,
  HealthStatus,
  IHealthDiagnosticsSource,
  IRuntimeServices,
  TimerHandle,
} from '@setu-ts/common';
import type { HealthDiagnosticsOptions } from '../interfaces/index.ts';
import { isHealthStatus } from '../services/health-status.ts';

/**
 * The already-computed outcome of one settled indicator, as the runner
 * reports it to the collector. Carries only framework-owned primitives: the
 * fixed observation state, the status (only when reported), and the measured
 * latency. It never carries `result.data` or any thrown value.
 *
 * `status` is typed `unknown` on purpose: an indicator is application code,
 * so the value it returned is untrusted until the collector has checked it
 * against the fixed `up`/`degraded`/`down` vocabulary.
 *
 * @internal
 */
export interface IndicatorOutcome {
  readonly state: HealthObservationState;
  readonly status?: unknown;
  readonly latencyMs: number;
}

/**
 * The single-indicator runner the collector's scheduler uses to run approved
 * indicators by name. The health service provides it; the collector never
 * imports the service or the indicator registry.
 *
 * @internal
 */
export interface HealthIndicatorRunner {
  /**
   * Runs one indicator by its registered name, returning the raw (undeadlined)
   * result promise, or `null` when no indicator is registered under the name.
   * The collector races the promise against the scheduled reporting deadline
   * and holds the name's in-flight slot until it settles. The collector reads
   * only the framework-owned `status`; the `data` field is never read or
   * retained.
   *
   * @param name - The registered indicator name
   * @returns The raw result promise, or `null` for an unregistered name
   */
  run(name: string): Promise<HealthCheckResult> | null;
}

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

/**
 * Recursively freezes a DTO so a reader holding it can observe nothing that
 * happens afterwards.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Advances a monotonic counter with saturation at `Number.MAX_SAFE_INTEGER`. */
function saturatingNext(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

/**
 * Reads the `status` of a settled indicator result without trusting its
 * shape: a `null` or non-object result, or a throwing getter, yields
 * `undefined` rather than an exception.
 *
 * @param result - The settled indicator result
 * @returns The raw `status` value, or `undefined`
 */
function readStatus(result: unknown): unknown {
  if (result === null || typeof result !== 'object') {
    return undefined;
  }
  try {
    return (result as { readonly status?: unknown }).status;
  } catch {
    return undefined;
  }
}

/** Fixed bounds (not configurable). */
const MAX_APPROVED_ALIASES = 64;
const MAX_ALIAS_BYTES = 64;
const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_SCHEDULED_INDICATORS = 16;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 300_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 30_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;

/**
 * The fixed 256 KiB snapshot budget, as the exact UTF-8 byte length of the
 * compact JSON — the same bound the connector measures on the wire.
 *
 * @internal
 */
export const MAX_HEALTH_SNAPSHOT_BYTES = 262_144;

/**
 * Fixed construction and read errors. Each names the constraint it enforces
 * and never echoes a supplied value: a construction-time diagnostics failure
 * is an attacker-reachable path for whatever the options contain.
 *
 * @internal
 */
export const COLLECTOR_ERRORS = {
  notEnabled: 'Health diagnostics: enabled must be the literal true.',
  badOptions: 'Health diagnostics: the diagnostics option must be an object.',
  badIndicators: 'Health diagnostics: indicators must map indicator names to aliases.',
  tooManyAliases: 'Health diagnostics: more than 64 approved indicators.',
  aliasBytes: 'Health diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Health diagnostics: an alias contains a control character.',
  duplicateAlias: 'Health diagnostics: an alias is not unique.',
  badStaleAfter: 'Health diagnostics: staleAfterMs must be a positive finite integer.',
  badScheduled: 'Health diagnostics: scheduled.indicators must be an array of names.',
  tooManyScheduled: 'Health diagnostics: more than 16 scheduled indicators.',
  scheduledNotApproved: 'Health diagnostics: a scheduled indicator is not an approved indicator.',
  badInterval: 'Health diagnostics: intervalMs must be an integer from 1000 to 300000.',
  badTimeout: 'Health diagnostics: timeoutMs must be an integer from 1 to 30000.',
  badConcurrency: 'Health diagnostics: concurrency must be an integer from 1 to 4.',
  badInstanceId: 'Health diagnostics: snapshot requires a non-empty instance identifier.',
} as const;

/**
 * The scheduled-collection policy after validation.
 *
 * @internal
 */
export interface CompiledScheduledPolicy {
  /** The approved names to collect, in declared order, de-duplicated. */
  readonly names: readonly string[];
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

/**
 * A validated health-observation policy. Produced once by
 * {@linkcode compileHealthDiagnosticsPolicy} at plugin construction.
 *
 * @internal
 */
export interface CompiledHealthDiagnosticsPolicy {
  /** Exact registered name → approved alias. */
  readonly aliasBySourceName: ReadonlyMap<string, string>;
  /** Approved alias → registered name, in declared (projection) order. */
  readonly sourceNameByAlias: ReadonlyMap<string, string>;
  readonly staleAfterMs: number;
  /** `null` when no scheduled collection was configured. */
  readonly scheduled: CompiledScheduledPolicy | null;
}

/** Reports whether a value is a plain non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates an integer option against an inclusive range. */
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates the health-observation options and compiles them into the
 * policy the collector runs. The ONE validation of these options: the plugin
 * factory calls it at construction, so an invalid option refuses before any
 * application exists, and the collector consumes only the compiled result.
 *
 * `enabled` is checked at runtime, not only by its literal-`true` type: a
 * JavaScript or configuration-driven caller passing `enabled: false` is
 * refused rather than silently opted in.
 *
 * @param options - The raw health-observation options
 * @returns The validated, compiled policy
 * @throws {RangeError} With a fixed, value-free message for any violation
 * @internal
 */
export function compileHealthDiagnosticsPolicy(
  options: HealthDiagnosticsOptions,
): CompiledHealthDiagnosticsPolicy {
  if (!isPlainRecord(options)) {
    throw new RangeError(COLLECTOR_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new RangeError(COLLECTOR_ERRORS.notEnabled);
  }
  if (!isPlainRecord(options.indicators)) {
    throw new RangeError(COLLECTOR_ERRORS.badIndicators);
  }

  // Compile the exact source-name -> alias map, validating every bound.
  const entries = Object.entries(options.indicators);
  if (entries.length > MAX_APPROVED_ALIASES) {
    throw new RangeError(COLLECTOR_ERRORS.tooManyAliases);
  }
  const encoder = new TextEncoder();
  const aliasBySourceName = new Map<string, string>();
  const sourceNameByAlias = new Map<string, string>();
  for (const [sourceName, alias] of entries) {
    if (typeof alias !== 'string') {
      throw new RangeError(COLLECTOR_ERRORS.badIndicators);
    }
    const bytes = encoder.encode(alias).length;
    if (bytes < 1 || bytes > MAX_ALIAS_BYTES) {
      throw new RangeError(COLLECTOR_ERRORS.aliasBytes);
    }
    if (hasControlCharacter(alias)) {
      throw new RangeError(COLLECTOR_ERRORS.aliasControl);
    }
    if (sourceNameByAlias.has(alias)) {
      throw new RangeError(COLLECTOR_ERRORS.duplicateAlias);
    }
    aliasBySourceName.set(sourceName, alias);
    sourceNameByAlias.set(alias, sourceName);
  }

  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!inRange(staleAfterMs, 1, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(COLLECTOR_ERRORS.badStaleAfter);
  }

  const scheduled = options.scheduled;
  if (scheduled === undefined) {
    return { aliasBySourceName, sourceNameByAlias, staleAfterMs, scheduled: null };
  }
  if (!isPlainRecord(scheduled) || !Array.isArray(scheduled.indicators)) {
    throw new RangeError(COLLECTOR_ERRORS.badScheduled);
  }
  if (scheduled.indicators.length > MAX_SCHEDULED_INDICATORS) {
    throw new RangeError(COLLECTOR_ERRORS.tooManyScheduled);
  }
  const names: string[] = [];
  for (const name of scheduled.indicators) {
    if (typeof name !== 'string' || !aliasBySourceName.has(name)) {
      throw new RangeError(COLLECTOR_ERRORS.scheduledNotApproved);
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  if (!inRange(scheduled.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS)) {
    throw new RangeError(COLLECTOR_ERRORS.badInterval);
  }
  if (!inRange(scheduled.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
    throw new RangeError(COLLECTOR_ERRORS.badTimeout);
  }
  if (!inRange(scheduled.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY)) {
    throw new RangeError(COLLECTOR_ERRORS.badConcurrency);
  }
  return {
    aliasBySourceName,
    sourceNameByAlias,
    staleAfterMs,
    scheduled: {
      names,
      intervalMs: scheduled.intervalMs,
      timeoutMs: scheduled.timeoutMs,
      concurrency: scheduled.concurrency,
    },
  };
}

/** One retained latest-per-alias observation. Holds the alias, never the source name. */
interface RetainedObservation {
  readonly state: HealthObservationState;
  readonly status?: HealthStatus;
  readonly latencyMs: number;
  readonly capturedAtMs: number;
  readonly origin: 'application' | 'scheduled';
}

/** The outcome of racing one raw indicator against the reporting deadline. */
type RaceOutcome =
  | { readonly kind: 'reported'; readonly status: unknown }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'failed' };

/**
 * The collector. Implements `IHealthDiagnosticsSource` and owns the bounded
 * scheduler. Constructed only when the health plugin's `diagnostics` option
 * is present; an absent option registers an inert disabled source instead.
 *
 * @since 0.8.0
 */
export class HealthObservationCollector implements IHealthDiagnosticsSource {
  readonly #policy: CompiledHealthDiagnosticsPolicy;
  readonly #clock: IRuntimeServices;
  readonly #runner: HealthIndicatorRunner;
  readonly #retained = new Map<string, RetainedObservation>();
  /** Scheduled names whose RAW callback has not settled yet. */
  readonly #inFlight = new Set<string>();
  /** Armed reporting-deadline timers, cleared on close. */
  readonly #deadlineTimers = new Set<TimerHandle>();
  #droppedObservations = 0;
  #closed = false;
  #started = false;
  #cycleInFlight = false;
  /** Rotation offset into the scheduled names, so no name is starved. */
  #cursor = 0;
  #intervalHandle: TimerHandle | null = null;

  /**
   * Creates the collector over an already-validated policy.
   *
   * @param policy - The compiled health-observation policy
   * @param clock - The runtime services (monotonic clock and timers)
   * @param runner - The single-indicator runner the scheduler uses
   */
  constructor(
    policy: CompiledHealthDiagnosticsPolicy,
    clock: IRuntimeServices,
    runner: HealthIndicatorRunner,
  ) {
    this.#policy = policy;
    this.#clock = clock;
    this.#runner = runner;
  }

  /**
   * The retention seam. Reports one settled indicator's already-computed
   * outcome. The source name is used ONLY for the exact alias lookup; an
   * unapproved name is counted as dropped and never retained. A `reported`
   * outcome whose status is not one of the framework's own statuses is
   * retained as `failed` with no status — the untrusted value is never
   * stored. A closed collector accepts no write: a late settlement is
   * discarded.
   *
   * @param sourceName - The indicator's registered name
   * @param outcome - The framework-owned outcome primitives
   * @param origin - Whether the check was a normal or a scheduled one
   */
  report(
    sourceName: string,
    outcome: IndicatorOutcome,
    origin: 'application' | 'scheduled',
  ): void {
    if (this.#closed) {
      return;
    }
    const alias = this.#policy.aliasBySourceName.get(sourceName);
    if (alias === undefined) {
      this.#droppedObservations = saturatingNext(this.#droppedObservations);
      return;
    }
    const status = outcome.status;
    const base = { latencyMs: outcome.latencyMs, capturedAtMs: this.#clock.hrtime(), origin };
    this.#retained.set(
      alias,
      outcome.state !== 'reported'
        ? { ...base, state: outcome.state }
        : isHealthStatus(status)
        ? { ...base, state: 'reported', status }
        : { ...base, state: 'failed' },
    );
  }

  /**
   * {@inheritDoc IHealthDiagnosticsSource.snapshot}
   *
   * Builds the minimized snapshot for every approved alias: a retained record
   * when one exists, otherwise a `never-observed` entry. The inspector state
   * reflects data freshness across the full approved set — `no-data` when
   * nothing has been reported, `stale` when any reported observation is older
   * than `staleAfterMs`, else `ready`.
   */
  snapshot(instanceId: string): HealthDiagnosticsSnapshot {
    if (typeof instanceId !== 'string' || instanceId === '') {
      throw new RangeError(COLLECTOR_ERRORS.badInstanceId);
    }
    const now = this.#clock.hrtime();
    const scheduledNames = this.#policy.scheduled?.names ?? [];
    const observations: HealthDiagnosticsObservation[] = [];
    let reportedCount = 0;
    let anyStale = false;
    for (const [alias, sourceName] of this.#policy.sourceNameByAlias) {
      const retained = this.#retained.get(alias);
      if (retained === undefined) {
        observations.push({
          indicatorAlias: alias,
          state: 'never-observed',
          latencyMs: null,
          ageMs: null,
          origin: scheduledNames.includes(sourceName) ? 'scheduled' : 'application',
        });
        continue;
      }
      const ageMs = now - retained.capturedAtMs;
      reportedCount += 1;
      if (ageMs > this.#policy.staleAfterMs) {
        anyStale = true;
      }
      observations.push({
        indicatorAlias: alias,
        ...(retained.status !== undefined ? { status: retained.status } : {}),
        state: retained.state,
        latencyMs: retained.latencyMs,
        ageMs,
        origin: retained.origin,
      });
    }
    const state = reportedCount === 0 ? 'no-data' : anyStale ? 'stale' : 'ready';
    return deepFreeze(
      applyHealthSnapshotBudget(
        { instanceId, state, droppedObservations: this.#droppedObservations },
        observations,
      ),
    );
  }

  /**
   * Starts the bounded scheduler, if one was configured. Called once from the
   * plugin's `onBootstrap`: it starts one guarded, non-awaited cycle and then
   * one runtime-owned interval. A no-op when closed, already started, or when
   * no scheduled indicators were configured.
   */
  startScheduled(): void {
    const scheduled = this.#policy.scheduled;
    if (this.#closed || this.#started || scheduled === null || scheduled.names.length === 0) {
      return;
    }
    this.#started = true;
    void this.#runCycle(scheduled).catch(() => {});
    this.#intervalHandle = this.#clock.setInterval(() => {
      void this.#runCycle(scheduled).catch(() => {});
    }, scheduled.intervalMs);
  }

  /**
   * Marks the collector closed FIRST, then clears the interval, every armed
   * reporting-deadline timer, and every retained observation. A raw callback
   * still in flight will settle later and find the collector closed, so its
   * outcome is discarded rather than retained. Idempotent.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#intervalHandle !== null) {
      this.#clock.clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
    for (const handle of this.#deadlineTimers) {
      this.#clock.clearTimeout(handle);
    }
    this.#deadlineTimers.clear();
    this.#retained.clear();
  }

  /**
   * Runs one guarded cycle over EVERY scheduled name that is not still in
   * flight, starting at the rotation cursor, with at most `concurrency`
   * callbacks running at once — counting raw callbacks left over from an
   * earlier cycle that have not settled. Skipped when closed or when a
   * predecessor cycle is still reporting, so cycles never overlap.
   *
   * The cycle waits only for each check's REPORTING race (bounded by
   * `timeoutMs`), never for a raw callback: a hung indicator keeps its own
   * in-flight slot until it settles, and the remaining slots keep serving
   * the other indicators. A name the slots could not reach this cycle is
   * first in line on the next one.
   */
  async #runCycle(scheduled: CompiledScheduledPolicy): Promise<void> {
    if (this.#closed || this.#cycleInFlight) {
      return;
    }
    this.#cycleInFlight = true;
    try {
      const names = scheduled.names;
      const order = [...names.slice(this.#cursor), ...names.slice(0, this.#cursor)];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (
          !this.#closed && next < order.length && this.#inFlight.size < scheduled.concurrency
        ) {
          const name = order[next];
          next += 1;
          if (this.#inFlight.has(name)) {
            continue;
          }
          await this.#checkOne(name, scheduled.timeoutMs);
        }
      };
      const workers = Math.max(0, scheduled.concurrency - this.#inFlight.size);
      await Promise.all(Array.from({ length: workers }, worker));
      this.#cursor = (this.#cursor + next) % names.length;
    } finally {
      this.#cycleInFlight = false;
    }
  }

  /**
   * Runs one scheduled indicator. The name's in-flight slot is claimed
   * synchronously and released only when the RAW callback settles; the
   * returned promise resolves as soon as the outcome is REPORTED — a check
   * that timed out for reporting purposes does not block the cycle, and
   * cannot start a replacement until its underlying work is done.
   *
   * A name with no registered indicator is skipped: it stays
   * `never-observed` rather than reporting a failure no indicator produced.
   */
  #checkOne(name: string, timeoutMs: number): Promise<void> {
    const startedAtMs = this.#clock.hrtime();
    let raw: Promise<HealthCheckResult> | null;
    try {
      raw = this.#runner.run(name);
    } catch {
      // A runner that throws synchronously is a failed check, never a fault
      // that escapes the cycle.
      this.report(
        name,
        { state: 'failed', latencyMs: this.#clock.hrtime() - startedAtMs },
        'scheduled',
      );
      return Promise.resolve();
    }
    if (raw === null) {
      return Promise.resolve();
    }
    this.#inFlight.add(name);
    const release = (): void => {
      this.#inFlight.delete(name);
    };
    raw.then(release, release);
    return this.#raceWithDeadline(raw, timeoutMs).then((race) => {
      const latencyMs = this.#clock.hrtime() - startedAtMs;
      const outcome: IndicatorOutcome = race.kind === 'reported'
        ? { state: 'reported', status: race.status, latencyMs }
        : { state: race.kind, latencyMs };
      this.report(name, outcome, 'scheduled');
    });
  }

  /**
   * Races one raw indicator against the reporting deadline. A deadline hit
   * resolves `timed-out` without cancelling the raw callback; a normal
   * settlement resolves `reported` with the (still untrusted) status; a
   * rejection resolves `failed`. The timer is cleared on either settle path
   * and tracked so `close()` can clear it too — no handle outlives the
   * collector.
   */
  #raceWithDeadline(raw: Promise<HealthCheckResult>, timeoutMs: number): Promise<RaceOutcome> {
    return new Promise<RaceOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: RaceOutcome): void => {
        if (!settled) {
          settled = true;
          this.#clock.clearTimeout(handle);
          this.#deadlineTimers.delete(handle);
          resolve(outcome);
        }
      };
      const handle = this.#clock.setTimeout(() => finish({ kind: 'timed-out' }), timeoutMs);
      this.#deadlineTimers.add(handle);
      raw.then(
        (result) => finish({ kind: 'reported', status: readStatus(result) }),
        () => finish({ kind: 'failed' }),
      );
    });
  }
}

/**
 * Applies the fixed 256 KiB snapshot budget to the final DTO: the exact UTF-8
 * byte length of the compact JSON encoding of the RETURNED object is the
 * number the wire consumer measures, so trimming runs on the final shape —
 * omitting later observations and setting `truncated` until it fits.
 *
 * The retained set is bounded to 64 aliases of bounded size, so the budget is
 * unreachable through real captures; the decidable trim is still carried and
 * tested directly rather than left behind an uncoverable branch.
 *
 * @param scalar - The snapshot's scalar members
 * @param observations - The projected observations, in stable alias order
 * @returns The bounded snapshot DTO
 * @internal
 */
export function applyHealthSnapshotBudget(
  scalar: {
    readonly instanceId: string;
    readonly state: HealthDiagnosticsSnapshot['state'];
    readonly droppedObservations: number;
  },
  observations: readonly HealthDiagnosticsObservation[],
): HealthDiagnosticsSnapshot {
  const encoder = new TextEncoder();
  const build = (
    kept: readonly HealthDiagnosticsObservation[],
    isTruncated: boolean,
  ): HealthDiagnosticsSnapshot => ({
    version: 1,
    instanceId: scalar.instanceId,
    state: scalar.state,
    observations: kept,
    truncated: isTruncated,
    droppedObservations: scalar.droppedObservations,
  });
  const measure = (candidate: HealthDiagnosticsSnapshot): number =>
    encoder.encode(JSON.stringify(candidate)).length;

  const whole = build(observations, false);
  if (measure(whole) <= MAX_HEALTH_SNAPSHOT_BYTES) {
    return whole;
  }
  // Dropping a suffix observation only shrinks the encoding, so the encoded
  // length is monotone in the retained count and the largest fitting prefix is
  // found by bisection.
  let low = 0;
  let high = observations.length - 1;
  let best = build([], true);
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = build(observations.slice(0, mid), true);
    if (measure(candidate) <= MAX_HEALTH_SNAPSHOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Health observation collector (M98d) — the health-plugin-owned, latest-only
 * retention and bounded scheduler behind `IHealthDiagnosticsSource`.
 *
 * The collector is the minimization seam. It accepts only framework-owned
 * primitives — the fixed observation state, the status (only when reported),
 * the measured latency, and the registered name used for an exact alias
 * lookup — and never an indicator's `data`, a thrown value, or an absolute
 * time. It retains ONE frozen observation per approved alias, never a
 * history, so memory stays constant under sustained input.
 *
 * A separately-controlled scheduler, enabled only when `options.scheduled` is
 * present, runs bounded cycles of approved indicators. A timeout is a
 * REPORTING bound, not a cancellation: a check that has not settled within
 * `timeoutMs` is reported as `timed-out`, but its raw callback remains marked
 * in-flight until it actually settles, so no replacement check for it starts
 * early and a hung callback cannot accumulate work. Closing the collector
 * marks it closed FIRST (so a late settlement is discarded), then clears the
 * interval and every retained observation — M98a's own teardown order.
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

/**
 * The already-computed outcome of one settled indicator, as the runner
 * reports it to the collector. Carries only framework-owned primitives: the
 * fixed observation state, the status (only when reported), and the measured
 * latency. It never carries `result.data` or any thrown value.
 *
 * @internal
 */
export interface IndicatorOutcome {
  readonly state: HealthObservationState;
  readonly status?: HealthStatus;
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
   * result promise. The collector races this against the scheduled reporting
   * deadline and waits for it to settle before releasing the in-flight gate.
   * The collector reads only the framework-owned `status`; the `data` field is
   * never read or retained.
   *
   * @param name - The registered indicator name
   * @returns The raw result promise
   */
  run(name: string): Promise<HealthCheckResult>;
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
  tooManyAliases: 'Health diagnostics: more than 64 approved indicators.',
  aliasBytes: 'Health diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Health diagnostics: an alias contains a control character.',
  duplicateAlias: 'Health diagnostics: an alias is not unique.',
  badStaleAfter: 'Health diagnostics: staleAfterMs must be a positive finite integer.',
  tooManyScheduled: 'Health diagnostics: more than 16 scheduled indicators.',
  scheduledNotApproved: 'Health diagnostics: a scheduled indicator is not an approved indicator.',
  badInterval: 'Health diagnostics: intervalMs must be an integer from 1000 to 300000.',
  badTimeout: 'Health diagnostics: timeoutMs must be an integer from 1 to 30000.',
  badConcurrency: 'Health diagnostics: concurrency must be an integer from 1 to 4.',
  badInstanceId: 'Health diagnostics: snapshot requires a non-empty instance identifier.',
} as const;

/** One retained latest-per-alias observation. */
interface RetainedObservation {
  readonly alias: string;
  readonly sourceName: string;
  readonly state: HealthObservationState;
  readonly status?: HealthStatus;
  readonly latencyMs: number;
  readonly capturedAtMs: number;
  readonly origin: 'application' | 'scheduled';
}

/** The outcome of racing one raw indicator against the reporting deadline. */
type RaceOutcome =
  | { readonly kind: 'reported'; readonly status: HealthStatus }
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
  readonly #aliasBySourceName: ReadonlyMap<string, string>;
  readonly #sourceNameByAlias: ReadonlyMap<string, string>;
  readonly #scheduledSourceNames: ReadonlySet<string>;
  readonly #staleAfterMs: number;
  readonly #clock: IRuntimeServices;
  readonly #runner: HealthIndicatorRunner;
  readonly #scheduledIntervalMs: number;
  readonly #scheduledTimeoutMs: number;
  readonly #scheduledConcurrency: number;
  readonly #retained = new Map<string, RetainedObservation>();
  readonly #inFlight = new Set<string>();
  #droppedObservations = 0;
  #closed = false;
  #started = false;
  #cycleInFlight = false;
  #intervalHandle: TimerHandle | null = null;

  /**
   * Creates the collector, validating the option bounds with value-free
   * errors. An invalid option refuses at plugin construction, before any
   * application exists.
   *
   * @param options - The health-observation policy
   * @param clock - The runtime services (monotonic clock and timers)
   * @param runner - The single-indicator runner the scheduler uses
   * @throws {RangeError} When any option violates a fixed bound
   */
  constructor(
    options: HealthDiagnosticsOptions,
    clock: IRuntimeServices,
    runner: HealthIndicatorRunner,
  ) {
    this.#clock = clock;
    this.#runner = runner;

    // Compile the exact source-name -> alias map, validating every bound.
    const entries = Object.entries(options.indicators);
    if (entries.length > MAX_APPROVED_ALIASES) {
      throw new RangeError(COLLECTOR_ERRORS.tooManyAliases);
    }
    const aliasBySourceName = new Map<string, string>();
    const sourceNameByAlias = new Map<string, string>();
    const seenAliases = new Set<string>();
    for (const [sourceName, alias] of entries) {
      const bytes = new TextEncoder().encode(alias).length;
      if (bytes < 1 || bytes > MAX_ALIAS_BYTES) {
        throw new RangeError(COLLECTOR_ERRORS.aliasBytes);
      }
      if (hasControlCharacter(alias)) {
        throw new RangeError(COLLECTOR_ERRORS.aliasControl);
      }
      if (seenAliases.has(alias)) {
        throw new RangeError(COLLECTOR_ERRORS.duplicateAlias);
      }
      seenAliases.add(alias);
      aliasBySourceName.set(sourceName, alias);
      sourceNameByAlias.set(alias, sourceName);
    }
    this.#aliasBySourceName = aliasBySourceName;
    this.#sourceNameByAlias = sourceNameByAlias;

    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (
      typeof staleAfterMs !== 'number' ||
      !Number.isFinite(staleAfterMs) ||
      !Number.isInteger(staleAfterMs) ||
      staleAfterMs <= 0
    ) {
      throw new RangeError(COLLECTOR_ERRORS.badStaleAfter);
    }
    this.#staleAfterMs = staleAfterMs;

    // Compile the scheduled subset, validating every bound.
    const scheduled = options.scheduled;
    if (scheduled === undefined) {
      this.#scheduledSourceNames = new Set<string>();
      this.#scheduledIntervalMs = 0;
      this.#scheduledTimeoutMs = 0;
      this.#scheduledConcurrency = 0;
      return;
    }
    if (scheduled.indicators.length > MAX_SCHEDULED_INDICATORS) {
      throw new RangeError(COLLECTOR_ERRORS.tooManyScheduled);
    }
    const scheduledSourceNames = new Set<string>();
    for (const name of scheduled.indicators) {
      if (!aliasBySourceName.has(name)) {
        throw new RangeError(COLLECTOR_ERRORS.scheduledNotApproved);
      }
      scheduledSourceNames.add(name);
    }
    if (
      !Number.isInteger(scheduled.intervalMs) ||
      scheduled.intervalMs < MIN_INTERVAL_MS ||
      scheduled.intervalMs > MAX_INTERVAL_MS
    ) {
      throw new RangeError(COLLECTOR_ERRORS.badInterval);
    }
    if (
      !Number.isInteger(scheduled.timeoutMs) ||
      scheduled.timeoutMs < MIN_TIMEOUT_MS ||
      scheduled.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new RangeError(COLLECTOR_ERRORS.badTimeout);
    }
    if (
      !Number.isInteger(scheduled.concurrency) ||
      scheduled.concurrency < MIN_CONCURRENCY ||
      scheduled.concurrency > MAX_CONCURRENCY
    ) {
      throw new RangeError(COLLECTOR_ERRORS.badConcurrency);
    }
    this.#scheduledSourceNames = scheduledSourceNames;
    this.#scheduledIntervalMs = scheduled.intervalMs;
    this.#scheduledTimeoutMs = scheduled.timeoutMs;
    this.#scheduledConcurrency = scheduled.concurrency;
  }

  /**
   * The retention seam. Reports one settled indicator's already-computed
   * outcome. The source name is used ONLY for the exact alias lookup; an
   * unapproved name is counted as dropped and never retained. A closed
   * collector accepts no write: a late settlement is discarded.
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
    const alias = this.#aliasBySourceName.get(sourceName);
    if (alias === undefined) {
      this.#droppedObservations = saturatingNext(this.#droppedObservations);
      return;
    }
    this.#retained.set(alias, {
      alias,
      sourceName,
      state: outcome.state,
      ...(outcome.state === 'reported' && outcome.status !== undefined
        ? { status: outcome.status }
        : {}),
      latencyMs: outcome.latencyMs,
      capturedAtMs: this.#clock.hrtime(),
      origin,
    });
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
    const observations: HealthDiagnosticsObservation[] = [];
    let reportedCount = 0;
    let anyStale = false;
    for (const [alias, sourceName] of this.#sourceNameByAlias) {
      const retained = this.#retained.get(alias);
      if (retained === undefined) {
        observations.push({
          indicatorAlias: alias,
          state: 'never-observed',
          latencyMs: null,
          ageMs: null,
          origin: this.#scheduledSourceNames.has(sourceName) ? 'scheduled' : 'application',
        });
        continue;
      }
      const ageMs = now - retained.capturedAtMs;
      const stale = ageMs > this.#staleAfterMs;
      reportedCount += 1;
      if (stale) {
        anyStale = true;
      }
      observations.push({
        indicatorAlias: alias,
        ...(retained.state === 'reported' && retained.status !== undefined
          ? { status: retained.status }
          : {}),
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
   * one runtime-owned interval. A no-op when closed or when no scheduled
   * indicators were configured.
   */
  startScheduled(): void {
    if (this.#closed || this.#started || this.#scheduledSourceNames.size === 0) {
      return;
    }
    this.#started = true;
    void this.#runCycle().catch(() => {});
    this.#intervalHandle = this.#clock.setInterval(() => {
      void this.#runCycle().catch(() => {});
    }, this.#scheduledIntervalMs);
  }

  /**
   * Marks the collector closed FIRST, then clears the interval and every
   * retained observation. A raw callback still in flight will settle later
   * and find the collector closed, so its outcome is discarded rather than
   * retained. Idempotent.
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
    this.#retained.clear();
  }

  /**
   * Runs one guarded cycle. Skipped when closed or when a predecessor cycle
   * is still in flight, so cycles never overlap. Runs up to `concurrency`
   * approved, not-in-flight indicators concurrently.
   */
  async #runCycle(): Promise<void> {
    if (this.#closed || this.#cycleInFlight) {
      return;
    }
    this.#cycleInFlight = true;
    try {
      const candidates = [...this.#scheduledSourceNames].filter(
        (name) => !this.#inFlight.has(name),
      );
      const batch = candidates.slice(0, this.#scheduledConcurrency);
      if (batch.length === 0) {
        return;
      }
      for (const name of batch) {
        this.#inFlight.add(name);
      }
      await Promise.all(batch.map((name) => this.#checkOne(name)));
    } finally {
      this.#cycleInFlight = false;
    }
  }

  /**
   * Runs one scheduled indicator: races the raw callback against the
   * reporting deadline, reports the bounded outcome, and waits for the raw
   * callback to actually settle before releasing the in-flight gate — so a
   * check that timed out for REPORTING purposes cannot start a replacement
   * until its underlying work is done.
   */
  async #checkOne(name: string): Promise<void> {
    const startedAtMs = this.#clock.hrtime();
    try {
      const raw = this.#runner.run(name);
      const race = await this.#raceWithDeadline(raw, this.#scheduledTimeoutMs);
      const latencyMs = this.#clock.hrtime() - startedAtMs;
      const outcome: IndicatorOutcome = race.kind === 'reported'
        ? { state: 'reported', status: race.status, latencyMs }
        : race.kind === 'timed-out'
        ? { state: 'timed-out', latencyMs }
        : { state: 'failed', latencyMs };
      this.report(name, outcome, 'scheduled');
      // The raw callback may still be running after the reporting deadline;
      // wait for it to settle so the in-flight gate is held until the work is
      // actually done, not merely reported.
      await raw.catch(() => {});
    } catch {
      // A runner that throws synchronously is a failed check, never a fault
      // that escapes the cycle.
      const latencyMs = this.#clock.hrtime() - startedAtMs;
      this.report(name, { state: 'failed', latencyMs }, 'scheduled');
    } finally {
      this.#inFlight.delete(name);
    }
  }

  /**
   * Races one raw indicator against the reporting deadline. A deadline hit
   * resolves `timed-out` without cancelling the raw callback; a normal
   * settlement resolves `reported` with the framework's own status; a
   * rejection resolves `failed`. The timer is cleared on either settle path
   * so no handle leaks per check.
   */
  #raceWithDeadline(
    raw: Promise<{ readonly status: HealthStatus }>,
    timeoutMs: number,
  ): Promise<RaceOutcome> {
    return new Promise<RaceOutcome>((resolve) => {
      let settled = false;
      const handle = this.#clock.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ kind: 'timed-out' });
        }
      }, timeoutMs);
      raw.then(
        (result) => {
          if (!settled) {
            settled = true;
            this.#clock.clearTimeout(handle);
            resolve({ kind: 'reported', status: result.status });
          }
        },
        () => {
          if (!settled) {
            settled = true;
            this.#clock.clearTimeout(handle);
            resolve({ kind: 'failed' });
          }
        },
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

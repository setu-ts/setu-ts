/**
 * Queue observation collector (M98f) — the queue-plugin-owned, bounded
 * attempt ring, job-alias map and depth scheduler behind
 * `IQueueDiagnosticsSource`.
 *
 * The collector is the minimization seam. The service hands it a job NAME, a
 * raw job IDENTIFIER and the attempt number when a job is dispatched, and the
 * framework-owned outcome and settlement primitives when the settlement call
 * returns — never a payload, a header, a claim token, the attempt limit or a
 * thrown value, none of which the observer signatures can even accept. The
 * name is used only for the exact allowlist lookup (an unapproved name is
 * neither observed nor counted), and the identifier only for the alias
 * lookup: what is retained is the approved queue alias and a session-local
 * `j<N>` alias.
 *
 * Every structure is bounded: 1,024 retained attempts, a 4,096-entry LRU
 * alias map, 2,048 simultaneously observed attempts and at most 64 latest
 * depth observations. Depth counts come only from a separately-controlled
 * scheduler that runs non-overlapping cycles; a count that misses its
 * reporting deadline is reported as timed out but keeps its concurrency slot
 * until its raw promise settles, so a hung backend cannot accumulate count
 * calls. A diagnostic read never counts, reserves or settles anything.
 *
 * Closing marks the collector closed FIRST (so a late settlement or count is
 * discarded), then clears the interval, every armed deadline timer, and every
 * retained attempt, alias and depth.
 *
 * @module
 */
import type {
  IQueueDiagnosticsSource,
  IRuntimeServices,
  QueueDepthCoverage,
  QueueDepthCycleCoverage,
  QueueDepthScope,
  QueueDiagnosticsSourceBatch,
  QueueProcessorOutcome,
  QueueSettlementState,
  QueueSourceAttemptObservation,
  QueueSourceDepthObservation,
  QueueSourceFailure,
  TimerHandle,
} from '@setu-ts/common';
import type { QueueDepths } from '../adapters/queue-adapter.ts';
import type { QueueDiagnosticsOptions } from '../interfaces/index.ts';

/** Fixed bounds (not configurable). */
const MAX_APPROVED_QUEUES = 64;
const MAX_ALIAS_BYTES = 64;
const MAX_RETAINED_ATTEMPTS = 1_024;
const MAX_JOB_ALIASES = 4_096;
const MAX_IN_FLIGHT_ATTEMPTS = 2_048;
const MAX_READ_LIMIT = 128;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 300_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 30_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;

/**
 * The fixed collector bounds, exposed for tests and the connector's own
 * bounds. Not configurable.
 *
 * @internal
 */
export const QUEUE_COLLECTOR_LIMITS = {
  approvedQueues: MAX_APPROVED_QUEUES,
  retainedAttempts: MAX_RETAINED_ATTEMPTS,
  jobAliases: MAX_JOB_ALIASES,
  inFlightAttempts: MAX_IN_FLIGHT_ATTEMPTS,
  readLimit: MAX_READ_LIMIT,
} as const;

/**
 * Fixed construction and read errors. Each names the constraint it enforces
 * and never echoes a supplied value.
 *
 * @internal
 */
export const QUEUE_COLLECTOR_ERRORS = {
  badOptions: 'Queue diagnostics: the diagnostics option must be an object.',
  notEnabled: 'Queue diagnostics: enabled must be the literal true.',
  badInstanceAlias: 'Queue diagnostics: instanceAlias must be a string.',
  badQueues: 'Queue diagnostics: queues must map job names to aliases.',
  tooManyQueues: 'Queue diagnostics: more than 64 approved queues.',
  aliasBytes: 'Queue diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Queue diagnostics: an alias contains a control character.',
  duplicateAlias: 'Queue diagnostics: a queue alias is not unique.',
  badDepths: 'Queue diagnostics: depths must be an object.',
  badInterval: 'Queue diagnostics: depths.intervalMs must be an integer from 1000 to 300000.',
  badTimeout: 'Queue diagnostics: depths.timeoutMs must be an integer from 1 to 30000.',
  badConcurrency: 'Queue diagnostics: depths.concurrency must be an integer from 1 to 4.',
  badCursor:
    'Queue diagnostics: read() requires a non-negative safe-integer cursor no greater than the ' +
    'current sequence and a limit from 1 to 128.',
} as const;

/**
 * The depth-scheduling policy after validation.
 *
 * @internal
 */
export interface CompiledQueueDepthPolicy {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

/**
 * A validated queue-observation policy, compiled once at plugin construction.
 *
 * @internal
 */
export interface CompiledQueueDiagnosticsPolicy {
  /** The configured display alias for this queue plugin instance. */
  readonly instanceAlias: string;
  /** Exact job name → approved alias. */
  readonly aliasByName: ReadonlyMap<string, string>;
  /** The approved job names, in declared (projection) order. */
  readonly names: readonly string[];
  /** `null` when no depth collection was configured. */
  readonly depths: CompiledQueueDepthPolicy | null;
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

/** Reports whether a value is a plain non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates an integer option against an inclusive range. */
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
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
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.aliasBytes);
  }
  if (hasControlCharacter(alias)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.aliasControl);
  }
}

/**
 * Validates the queue-observation options and compiles them into the policy
 * the collector runs. The ONE validation of these options: the plugin factory
 * calls it at construction, so an invalid option refuses before any
 * application exists.
 *
 * `enabled` is checked at runtime, not only by its literal-`true` type: a
 * JavaScript or configuration-driven caller passing `enabled: false` is
 * refused rather than silently opted in.
 *
 * @param options - The raw queue-observation options
 * @returns The validated, compiled policy
 * @throws {RangeError} With a fixed, value-free message for any violation
 * @internal
 */
export function compileQueueDiagnosticsPolicy(
  options: QueueDiagnosticsOptions,
): CompiledQueueDiagnosticsPolicy {
  if (!isPlainRecord(options)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.notEnabled);
  }
  if (typeof options.instanceAlias !== 'string') {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badInstanceAlias);
  }
  assertAliasShape(options.instanceAlias);
  if (!isPlainRecord(options.queues)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badQueues);
  }
  const entries = Object.entries(options.queues);
  if (entries.length > MAX_APPROVED_QUEUES) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.tooManyQueues);
  }
  const aliasByName = new Map<string, string>();
  const seen = new Set<string>();
  for (const [name, alias] of entries) {
    if (typeof alias !== 'string') {
      throw new RangeError(QUEUE_COLLECTOR_ERRORS.badQueues);
    }
    assertAliasShape(alias);
    if (seen.has(alias)) {
      throw new RangeError(QUEUE_COLLECTOR_ERRORS.duplicateAlias);
    }
    seen.add(alias);
    aliasByName.set(name, alias);
  }
  const names = [...aliasByName.keys()];
  const depths = options.depths;
  if (depths === undefined) {
    return { instanceAlias: options.instanceAlias, aliasByName, names, depths: null };
  }
  if (!isPlainRecord(depths)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badDepths);
  }
  if (!inRange(depths.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badInterval);
  }
  if (!inRange(depths.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badTimeout);
  }
  if (!inRange(depths.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY)) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badConcurrency);
  }
  return {
    instanceAlias: options.instanceAlias,
    aliasByName,
    names,
    depths: {
      intervalMs: depths.intervalMs,
      timeoutMs: depths.timeoutMs,
      concurrency: depths.concurrency,
    },
  };
}

/**
 * Validates `read()` arguments against the source's current sequence.
 *
 * @param after - The exclusive cursor
 * @param limit - The requested limit, or `undefined` for the default
 * @param current - The highest sequence a cursor may name
 * @returns The effective limit
 * @throws {RangeError} With one fixed, value-free message
 * @internal
 */
export function validateQueueReadArgs(
  after: unknown,
  limit: unknown,
  current: number,
): number {
  const effective = limit ?? MAX_READ_LIMIT;
  if (
    typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after > current ||
    !inRange(effective, 1, MAX_READ_LIMIT)
  ) {
    throw new RangeError(QUEUE_COLLECTOR_ERRORS.badCursor);
  }
  return effective;
}

/**
 * One observed attempt, as the service reports its settlement. Returned by
 * {@linkcode QueueAttemptObserver.begin} for an approved, observable attempt.
 *
 * @internal
 */
export interface QueueAttemptHandle {
  /**
   * Records the attempt's outcome and what was observed about settling it,
   * AFTER the settlement call returned. Idempotent: a second call is ignored.
   *
   * @param outcome - How the dispatched work completed
   * @param settlement - What the runner observed about the settlement call
   */
  settled(outcome: QueueProcessorOutcome, settlement: QueueSettlementState): void;
}

/**
 * The dispatch-side seam the service calls. Accepts only a job name, a raw
 * job identifier (for the alias lookup alone) and the attempt number.
 *
 * @internal
 */
export interface QueueAttemptObserver {
  /**
   * Begins observing one dispatched attempt.
   *
   * @param name - The job name, used only for the exact allowlist lookup
   * @param jobId - The raw job identifier, used only for the alias lookup
   * @param attempt - The 1-based attempt number
   * @returns A handle, or `null` when the attempt is not observed
   */
  begin(name: string, jobId: string, attempt: number): QueueAttemptHandle | null;
}

/**
 * The depth-count seam the service provides to the scheduler. The collector
 * never imports the service or the adapter.
 *
 * @internal
 */
export interface QueueDepthReader {
  /** What this adapter's counts cover. */
  readonly scope: QueueDepthScope;
  /** Whether the adapter can count right now. */
  supported(): boolean;
  /** The job names this instance has registered a processor for. */
  names(): readonly string[];
  /**
   * Counts one job name's states. May throw or reject; the collector reports
   * either as a failed count.
   *
   * @param name - The job name
   * @returns The raw count promise
   */
  read(name: string): Promise<QueueDepths>;
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

/** Reports whether a count is a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads an untrusted depth result: an object carrying three non-negative
 * safe-integer counts, read through their own properties once. Anything else
 * — including a throwing getter — is a failed count.
 *
 * @param value - The settled count result
 * @returns The validated counts, or `null`
 * @internal
 */
export function readDepthResult(value: unknown): QueueDepths | null {
  try {
    if (!isPlainRecord(value)) {
      return null;
    }
    const ready = value.ready;
    const processing = value.processing;
    const dead = value.dead;
    return isCount(ready) && isCount(processing) && isCount(dead)
      ? { ready, processing, dead }
      : null;
  } catch {
    return null;
  }
}

/**
 * The inert, disabled queue-diagnostics source, registered when the queue
 * plugin's `diagnostics` option is absent. It observes nothing — no ring, no
 * alias map, no timer — and still validates its arguments with the same
 * fixed message as the active source.
 *
 * @returns The disabled source
 * @internal
 */
export function createDisabledQueueSource(): IQueueDiagnosticsSource {
  return {
    read(after: number, limit?: number): QueueDiagnosticsSourceBatch {
      validateQueueReadArgs(after, limit, 0);
      return deepFreeze({
        version: 1,
        state: 'disabled',
        depthCoverage: 'disabled',
        failure: 'none',
        attempts: [],
        depths: [],
        next: after,
        lost: 0,
        closed: false,
        droppedAttempts: 0,
        evictedJobAliases: 0,
      });
    },
  };
}

/** One retained attempt. Holds aliases only — never a job name or identifier. */
interface RetainedAttempt {
  readonly sequence: number;
  readonly queueAlias: string;
  readonly jobAlias: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: QueueProcessorOutcome;
  readonly settlement: QueueSettlementState;
  readonly settledAtMs: number;
}

/** One retained latest depth. */
interface RetainedDepth {
  readonly ready: number;
  readonly processing: number;
  readonly dead: number;
  readonly coverage: QueueDepthCycleCoverage;
  readonly capturedAtMs: number;
}

/** The outcome of racing one raw count against its reporting deadline. */
type CountOutcome =
  | { readonly kind: 'ok'; readonly depths: QueueDepths; readonly atMs: number }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'failed' };

/**
 * The collector. Implements `IQueueDiagnosticsSource` and the service-facing
 * {@linkcode QueueAttemptObserver}, and owns the bounded depth scheduler.
 * Constructed only when the queue plugin's `diagnostics` option is present.
 *
 * @internal
 */
export class QueueObservationCollector implements IQueueDiagnosticsSource, QueueAttemptObserver {
  readonly #policy: CompiledQueueDiagnosticsPolicy;
  readonly #clock: IRuntimeServices;
  readonly #confirmsSettlement: boolean;
  readonly #attempts: RetainedAttempt[] = [];
  /** Raw job identifier → `j<N>`, least-recently-used first. */
  readonly #jobAliases = new Map<string, string>();
  /** Approved queue alias → latest counts. */
  readonly #depths = new Map<string, RetainedDepth>();
  /** Job names whose RAW count promise has not settled. */
  readonly #countsInFlight = new Set<string>();
  readonly #deadlineTimers = new Set<TimerHandle>();
  #sequence = 0;
  #nextJobAlias = 0;
  #attemptsInFlight = 0;
  /** Bumped on close so a handle issued before it can never touch new state. */
  #generation = 0;
  #droppedAttempts = 0;
  #evictedJobAliases = 0;
  #depthCoverage: QueueDepthCoverage;
  #failure: QueueSourceFailure = 'none';
  #closed = false;
  #started = false;
  #cycleInFlight = false;
  #cursor = 0;
  #intervalHandle: TimerHandle | null = null;
  /** The attached depth reader's scope; only read once a depth has been retained. */
  #scope: QueueDepthScope = 'process-local';

  /**
   * Creates the collector over an already-validated policy.
   *
   * @param policy - The compiled queue-observation policy
   * @param clock - The runtime services (monotonic clock and timers)
   * @param confirmsSettlement - Whether the adapter's settlement calls
   * resolve only after the backend applied them; when `false`, a completed
   * call is recorded as `unknown`, never as settlement proof
   */
  constructor(
    policy: CompiledQueueDiagnosticsPolicy,
    clock: IRuntimeServices,
    confirmsSettlement: boolean,
  ) {
    this.#policy = policy;
    this.#clock = clock;
    this.#confirmsSettlement = confirmsSettlement;
    this.#depthCoverage = policy.depths === null ? 'disabled' : 'pending';
  }

  /** {@inheritDoc QueueAttemptObserver.begin} */
  begin(name: string, jobId: string, attempt: number): QueueAttemptHandle | null {
    if (this.#closed) {
      return null;
    }
    const queueAlias = this.#policy.aliasByName.get(name);
    if (queueAlias === undefined) {
      return null;
    }
    if (this.#attemptsInFlight >= MAX_IN_FLIGHT_ATTEMPTS) {
      this.#droppedAttempts = saturatingNext(this.#droppedAttempts);
      return null;
    }
    const jobAlias = this.#aliasFor(jobId);
    this.#attemptsInFlight += 1;
    const generation = this.#generation;
    const startedAtMs = this.#clock.hrtime();
    let done = false;
    return {
      settled: (outcome, settlement) => {
        if (done) {
          return;
        }
        done = true;
        if (this.#closed || generation !== this.#generation) {
          return;
        }
        this.#attemptsInFlight -= 1;
        const settledAtMs = this.#clock.hrtime();
        this.#sequence += 1;
        this.#attempts.push({
          sequence: this.#sequence,
          queueAlias,
          jobAlias,
          attempt,
          durationMs: settledAtMs - startedAtMs,
          outcome,
          settlement: this.#confirmsSettlement || settlement === 'failed' ? settlement : 'unknown',
          settledAtMs,
        });
        if (this.#attempts.length > MAX_RETAINED_ATTEMPTS) {
          this.#attempts.shift();
        }
      },
    };
  }

  /**
   * Returns the session-local alias for a raw job identifier, refreshing its
   * recency. A full map evicts its least-recently-used entry and counts the
   * eviction, so a later retry of that job receives a NEW alias.
   */
  #aliasFor(jobId: string): string {
    const existing = this.#jobAliases.get(jobId);
    if (existing !== undefined) {
      this.#jobAliases.delete(jobId);
      this.#jobAliases.set(jobId, existing);
      return existing;
    }
    if (this.#jobAliases.size >= MAX_JOB_ALIASES) {
      const oldest = this.#jobAliases.keys().next().value as string;
      this.#jobAliases.delete(oldest);
      this.#evictedJobAliases = saturatingNext(this.#evictedJobAliases);
    }
    this.#nextJobAlias += 1;
    const alias = `j${this.#nextJobAlias}`;
    this.#jobAliases.set(jobId, alias);
    return alias;
  }

  /**
   * {@inheritDoc IQueueDiagnosticsSource.read}
   *
   * Follows the M98a cursor contract exactly: a cursor parked behind an
   * eviction receives the oldest retained attempts with the skipped
   * sequences reported as `lost`, `after: 0` is not special-cased, and a
   * closed source answers an empty closed batch rather than a range refusal.
   */
  read(after: number, limit?: number): QueueDiagnosticsSourceBatch {
    const effective = validateQueueReadArgs(
      after,
      limit,
      this.#closed ? Number.MAX_SAFE_INTEGER : this.#sequence,
    );
    const now = this.#clock.hrtime();
    const common = {
      version: 1 as const,
      instanceAlias: this.#policy.instanceAlias,
      depthCoverage: this.#depthCoverage,
      failure: this.#failure,
      droppedAttempts: this.#droppedAttempts,
      evictedJobAliases: this.#evictedJobAliases,
    };
    if (this.#closed) {
      return deepFreeze({
        ...common,
        state: 'no-data',
        attempts: [],
        depths: [],
        next: after,
        lost: 0,
        closed: true,
      });
    }
    const first = this.#attempts.length > 0 ? this.#attempts[0].sequence : this.#sequence + 1;
    const start = Math.max(after + 1, first);
    const attempts: QueueSourceAttemptObservation[] = [];
    for (const retained of this.#attempts) {
      if (retained.sequence < start) {
        continue;
      }
      if (attempts.length === effective) {
        break;
      }
      attempts.push({
        sequence: retained.sequence,
        queueAlias: retained.queueAlias,
        jobAlias: retained.jobAlias,
        attempt: retained.attempt,
        durationMs: retained.durationMs,
        outcome: retained.outcome,
        settlement: retained.settlement,
        ageMs: now - retained.settledAtMs,
      });
    }
    const depths: QueueSourceDepthObservation[] = [];
    for (const name of this.#policy.names) {
      const queueAlias = this.#policy.aliasByName.get(name)!;
      const retained = this.#depths.get(queueAlias);
      if (retained !== undefined) {
        depths.push({
          queueAlias,
          ready: retained.ready,
          processing: retained.processing,
          dead: retained.dead,
          scope: this.#scope,
          coverage: retained.coverage,
          ageMs: now - retained.capturedAtMs,
        });
      }
    }
    return deepFreeze({
      ...common,
      state: this.#sequence === 0 && this.#depths.size === 0 ? 'no-data' : 'ready',
      attempts,
      depths,
      next: attempts.length > 0 ? attempts[attempts.length - 1].sequence : after,
      lost: attempts.length > 0 ? start - after - 1 : 0,
      closed: false,
    });
  }

  /**
   * Starts the bounded depth scheduler, if one was configured. Called once
   * from the plugin's `onBootstrap`: one guarded, non-awaited cycle, then one
   * runtime-owned interval. A no-op when closed, already started, or when no
   * depth collection was configured.
   *
   * @param reader - The service's depth-count seam
   */
  startDepths(reader: QueueDepthReader): void {
    const depths = this.#policy.depths;
    if (this.#closed || this.#started || depths === null) {
      return;
    }
    this.#started = true;
    this.#scope = reader.scope;
    void this.#runCycle(reader, depths).catch(() => {});
    this.#intervalHandle = this.#clock.setInterval(() => {
      void this.#runCycle(reader, depths).catch(() => {});
    }, depths.intervalMs);
  }

  /**
   * Marks the collector closed FIRST, then clears the interval, every armed
   * deadline timer, and every retained attempt, alias and depth. A settlement
   * or count arriving later finds the collector closed and is discarded.
   * Idempotent.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#generation += 1;
    if (this.#intervalHandle !== null) {
      this.#clock.clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
    for (const handle of this.#deadlineTimers) {
      this.#clock.clearTimeout(handle);
    }
    this.#deadlineTimers.clear();
    this.#attempts.length = 0;
    this.#jobAliases.clear();
    this.#depths.clear();
    this.#countsInFlight.clear();
    this.#attemptsInFlight = 0;
  }

  /**
   * Runs one guarded depth cycle over every approved job name this instance
   * processes, starting at the rotation cursor, with at most `concurrency`
   * count calls in flight — counting raw calls left over from an earlier
   * cycle. Skipped when closed or when a predecessor cycle is still
   * reporting, so cycles never overlap. Fresh counts are committed together
   * once the cycle's reporting races finish, each tagged with the cycle's
   * coverage.
   */
  async #runCycle(reader: QueueDepthReader, policy: CompiledQueueDepthPolicy): Promise<void> {
    if (this.#closed || this.#cycleInFlight) {
      return;
    }
    this.#cycleInFlight = true;
    try {
      if (!reader.supported()) {
        this.#depthCoverage = 'unavailable';
        this.#failure = 'none';
        this.#depths.clear();
        return;
      }
      const registered = new Set(reader.names());
      const names = this.#policy.names.filter((name) => registered.has(name));
      const order = names.length === 0 ? [] : [
        ...names.slice(this.#cursor % names.length),
        ...names.slice(0, this.#cursor % names.length),
      ];
      const fresh = new Map<string, { depths: QueueDepths; atMs: number }>();
      let failed = false;
      let timedOut = false;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (
          !this.#closed && next < order.length && this.#countsInFlight.size < policy.concurrency
        ) {
          const name = order[next];
          next += 1;
          if (this.#countsInFlight.has(name)) {
            continue;
          }
          const outcome = await this.#countOne(reader, name, policy.timeoutMs);
          if (outcome.kind === 'ok') {
            fresh.set(name, { depths: outcome.depths, atMs: outcome.atMs });
          } else if (outcome.kind === 'failed') {
            failed = true;
          } else {
            timedOut = true;
          }
        }
      };
      const workers = Math.max(0, policy.concurrency - this.#countsInFlight.size);
      await Promise.all(Array.from({ length: workers }, worker));
      if (this.#closed) {
        return;
      }
      if (names.length > 0) {
        this.#cursor = (this.#cursor + next) % names.length;
      }
      const coverage: QueueDepthCycleCoverage = fresh.size === names.length
        ? 'complete'
        : 'partial';
      for (const [name, result] of fresh) {
        this.#depths.set(this.#policy.aliasByName.get(name)!, {
          ...result.depths,
          coverage,
          capturedAtMs: result.atMs,
        });
      }
      this.#depthCoverage = coverage;
      this.#failure = failed ? 'depth-read-failed' : timedOut ? 'depth-read-timed-out' : 'none';
    } finally {
      this.#cycleInFlight = false;
    }
  }

  /**
   * Counts one job name. Its in-flight slot is claimed synchronously and
   * released only when the RAW count settles; the returned promise resolves
   * as soon as the outcome is REPORTED, so a count that timed out for
   * reporting purposes does not block the cycle and cannot start a
   * replacement until its underlying call is done.
   */
  #countOne(reader: QueueDepthReader, name: string, timeoutMs: number): Promise<CountOutcome> {
    let raw: Promise<QueueDepths>;
    try {
      raw = Promise.resolve(reader.read(name));
    } catch {
      return Promise.resolve({ kind: 'failed' });
    }
    this.#countsInFlight.add(name);
    const generation = this.#generation;
    const release = (): void => {
      if (generation === this.#generation) {
        this.#countsInFlight.delete(name);
      }
    };
    raw.then(release, release);
    return new Promise<CountOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CountOutcome): void => {
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
        (value) => {
          const depths = readDepthResult(value);
          finish(
            depths === null ? { kind: 'failed' } : {
              kind: 'ok',
              depths,
              atMs: this.#clock.hrtime(),
            },
          );
        },
        () => finish({ kind: 'failed' }),
      );
    });
  }
}

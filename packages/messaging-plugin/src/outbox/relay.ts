/**
 * One sweep of one store's pending set (M107 §3.6–§3.9).
 *
 * The sweep pages `scanPending(cursor, …)` and examines rows ONE AT A TIME in
 * `position` order while three budgets last: rows examined (`scanLimit`),
 * rows published or poisoned (`publishLimit`), and one deadline over the
 * whole sweep (`sweepDeadlineMs`, on the monotonic clock). A row starts only
 * while the deadline leaves room for its publish AND its status write.
 *
 * The deadline bounds the sweep, EXCEPT that the status write settling an
 * already-invoked publish runs to its own `storeTimeoutMs` even when a pause
 * has exhausted the budget: the publish happened, and recording its outcome
 * is that row's work. A sweep that overran by a pause can therefore outlive
 * `sweepDeadlineMs` by at most one `storeTimeoutMs`; the drain on shutdown
 * waits for the in-flight sweep, so its bound grows by the same amount.
 *
 * Every status write is a conditional transition (the store writes only from
 * the expected status). A rejected or expired store call ends the sweep with
 * the row's key blocked, so no later row of that key is published before the
 * next lap re-reads the still-`pending` row. A settlement write that answers
 * after its bound is still observed: the relay blocks the key and books the
 * sweep failure when the bound wins, and the store's eventual answer records
 * its overlap (or is swallowed, when it is the same failure) through one
 * shared observation. Once the outbox is closing, a publish failure writes
 * nothing — a failure the application's own shutdown caused is never counted
 * against `maxAttempts`.
 *
 * @module
 */
import type {
  IMessageBroker,
  IOutboxStore,
  IRuntimeServices,
  ITelemetryService,
  OutboxRecord,
  OutboxTransition,
  SpanOptions,
} from '@setu-ts/common';
import { parseTraceparentToContext, resolveProbeTiming, withDeadline } from '@setu-ts/common';

import { describeError } from '../brokers/describe-error.ts';
import { OutboxLap } from './lap.ts';
import type { ResolvedOutboxOptions } from './options.ts';
import { blockKey } from './position.ts';
import type { DecodedOutboxRow } from './record-codec.ts';
import { claimStateOf, decodeOutboxRecord } from './record-codec.ts';

/** The most characters of `lastError` a row stores. */
const MAX_LAST_ERROR = 1024;

/**
 * Why one store's part of a sweep ended.
 *
 * @internal
 */
export type StoreSweepEnd =
  'lap-complete' | 'scan-limit' | 'publish-limit' | 'deadline' | 'store-failure' | 'closing';

/**
 * What a sweep reports as it goes — the hooks the outbox service records for
 * health and forwards to the optional metrics collector. Implementations must
 * not throw.
 *
 * @internal
 */
export interface OutboxRelayObserver {
  /** A row was published. */
  published(topic: string): void;
  /** A publish failed and the failure was recorded (or the store refused it). */
  publishFailed(topic: string): void;
  /** A row became `failed`; `topic` is absent for an undecodable row. */
  poisoned(topic: string | undefined): void;
  /**
   * A relay was fenced, lost its held claim, or found a published row already sent.
   */
  overlap(kind: 'fenced' | 'claim-lost' | 'duplicate'): void;
}

/**
 * The counters and clock one sweep shares across every store it visits.
 *
 * @internal
 */
export class SweepBudget {
  readonly #runtime: IRuntimeServices;
  readonly #startedAt: number;
  readonly #deadlineMs: number;
  /** Rows examined, skips included. */
  scanned = 0;
  /** Rows published or poisoned — what `publishLimit` bounds. */
  attempted = 0;
  /** Rows published. */
  published = 0;
  /** Publish failures recorded. */
  failures = 0;
  /** Rows made `failed`. */
  poisoned = 0;

  /**
   * @param runtime - Supplies the monotonic clock
   * @param deadlineMs - `sweepDeadlineMs`
   */
  constructor(runtime: IRuntimeServices, deadlineMs: number) {
    this.#runtime = runtime;
    this.#deadlineMs = deadlineMs;
    this.#startedAt = runtime.hrtime();
  }

  /** Milliseconds left before the sweep deadline. */
  remaining(): number {
    return this.#deadlineMs - (this.#runtime.hrtime() - this.#startedAt);
  }
}

/**
 * Everything one sweep needs.
 *
 * @internal
 */
export interface RelayContext {
  readonly runtime: IRuntimeServices;
  readonly broker: IMessageBroker;
  readonly telemetry: ITelemetryService | undefined;
  readonly options: ResolvedOutboxOptions;
  /** This outbox instance's id. */
  readonly instanceId: string;
  /** What requested this sweep. */
  readonly origin: 'scheduled' | 'dispatch';
  readonly isClosing: () => boolean;
  readonly observer: OutboxRelayObserver;
  readonly budget: SweepBudget;
}

/**
 * The lap a store's sweep resumes. The service keeps one per store; a sweep
 * clears it when the lap ends.
 *
 * @internal
 */
export interface LapHolder {
  lap: OutboxLap | undefined;
  /**
   * Whether the most recently COMPLETED lap overflowed its blocked set. A lap
   * that overflows usually ends in the same sweep that overflowed it, which
   * clears {@linkcode lap} before any health read; this keeps the signal until
   * a later lap completes without overflowing.
   */
  lastLapOverflowed: boolean;
}

/** An expired relay or purge call: a failure, after which the sweep (or purge) ends. */
class RelayCallTimeoutError extends Error {
  constructor(what: string) {
    super(`outbox: ${what} did not settle within its bound`);
    this.name = 'RelayCallTimeoutError';
  }
}

/**
 * Runs one call under `min(perCall, remaining)`, so no call outlives the
 * deadline `budget` was started with. The ONE implementation of that rule:
 * the sweep's calls and the purge job's calls both go through it.
 *
 * @internal
 * @param runtime - Supplies the timer the bound runs on
 * @param budget - The deadline the call must not outlive
 * @param perCallMs - The call's own bound
 * @param what - Names the call in the expiry error
 * @param run - The call
 * @returns The call's value, or a rejection with its error or the expiry
 */
export function boundedCall<T>(
  runtime: IRuntimeServices,
  budget: SweepBudget,
  perCallMs: number,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  const remaining = Math.ceil(budget.remaining());
  if (remaining <= 0) return Promise.reject(new RelayCallTimeoutError(what));
  return withDeadline(() => run(), {
    timeoutMs: Math.min(perCallMs, remaining),
    onTimeout: () => new RelayCallTimeoutError(what),
    timing: resolveProbeTiming(runtime),
  });
}

/** {@linkcode boundedCall} on a sweep's own runtime and budget. */
function bounded<T>(
  ctx: RelayContext,
  perCallMs: number,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  return boundedCall(ctx.runtime, ctx.budget, perCallMs, what, run);
}

/** The budget that stops the sweep before its next row or page, if any. */
function stopReason(ctx: RelayContext): StoreSweepEnd | undefined {
  const { options, budget } = ctx;
  if (ctx.isClosing()) return 'closing';
  if (budget.remaining() < options.publishTimeoutMs + 2 * options.storeTimeoutMs) return 'deadline';
  if (budget.scanned >= options.scanLimit) return 'scan-limit';
  if (budget.attempted >= options.publishLimit) return 'publish-limit';
  return undefined;
}

/** A stored attempt count, or `0` when the row carries an unusable one. */
function attemptsOf(record: OutboxRecord): number {
  return Number.isSafeInteger(record.attempts) && record.attempts >= 0 ? record.attempts : 0;
}

/** `describeError`, cut to the stored length on a code-point boundary. */
function lastErrorOf(error: unknown): string {
  return Array.from(describeError(error)).slice(0, MAX_LAST_ERROR).join('');
}

/**
 * The span options for a row: a stored `traceparent` that parses to BOTH ids
 * re-parents the relay span; anything else — absent, malformed, edited —
 * starts a ROOT span, never one under whatever span happens to be active.
 */
function spanOptionsFor(record: OutboxRecord): SpanOptions {
  const stored = typeof record.traceparent === 'string' ? record.traceparent : null;
  const parent = parseTraceparentToContext(stored);
  return parent.traceId !== undefined && parent.spanId !== undefined
    ? { kind: 'internal', parentContext: parent }
    : { kind: 'internal', root: true };
}

/** Publishes one decoded row, inside a relay span when telemetry is present. */
function publish(ctx: RelayContext, record: OutboxRecord, row: DecodedOutboxRow): Promise<void> {
  const send = () => ctx.broker.publish(row.topic, row.envelope, row.options);
  if (ctx.telemetry === undefined) return send();
  return ctx.telemetry.withSpan(`outbox relay ${row.topic}`, send, spanOptionsFor(record));
}

/**
 * Runs a settlement write under its own `storeTimeoutMs` bound — not
 * `min(storeTimeoutMs, remaining)` — and always invokes the call. The write
 * settles a publish that was already invoked, so it is that row's work even
 * when a pause has exhausted the sweep budget.
 *
 * The store's own promise is kept: when the bound wins the race, the caller
 * still observes the store's eventual answer (or swallows its eventual
 * rejection) through it.
 *
 * @internal
 * @param ctx - The sweep's shared context
 * @param what - Names the call in the expiry error
 * @param run - The call
 * @returns The bounded promise and the store's own promise
 */
function boundedSettle<T>(
  ctx: RelayContext,
  what: string,
  run: () => Promise<T>,
): { readonly bounded: Promise<T>; readonly store: Promise<T> } {
  const store = Promise.resolve().then(run);
  return {
    bounded: withDeadline(() => store, {
      timeoutMs: ctx.options.storeTimeoutMs,
      onTimeout: () => new RelayCallTimeoutError(what),
      timing: resolveProbeTiming(ctx.runtime),
    }),
    store,
  };
}

/**
 * What one settlement answer does to the observer and, in time only, to the
 * lap and the budget.
 *
 * @internal
 */
interface SettlementObservation {
  /** `true` on the late continuation: the lap and the budget are untouched. */
  readonly late: boolean;
  /** In time only: the lap a claim-lost or failed answer blocks. */
  readonly lap?: OutboxLap;
  readonly key?: string;
  /** The topic a `markFailure` answer reports through `poisoned`. */
  readonly topic?: string;
  /** Whether the `markFailure` write carried `status: 'failed'`. */
  readonly madeFailed?: boolean;
}

/**
 * Records what a settlement write answered — the ONE function the in-time and
 * the late paths both call, so the two cannot disagree about what an answer
 * means:
 *
 * | write       | answer                       | records            | in time also          |
 * | ----------- | ---------------------------- | ------------------ | --------------------- |
 * | `markSent`  | `not-pending` / `sent`       | `duplicate`        | —                     |
 * | `markSent`  | `claim-lost`                 | `claim-lost`       | block the key         |
 * | `markSent`  | `not-pending` / `failed`     | —                  | block the key         |
 * | `markFailure` | `not-pending` / `sent`     | `duplicate`        | —                     |
 * | `markFailure` | `claim-lost`               | `claim-lost`       | —                     |
 * | `markFailure` | `applied`, wrote `failed`  | `poisoned(topic)` | `budget.poisoned` + 1 |
 * | both writes | `applied` (other), `missing` | —                  | —                     |
 *
 * A late answer arrives after the sweep ended: it never touches the lap or
 * the budget, it is dropped when the outbox is closing, and a throwing
 * custom observer cannot surface as an unhandled rejection.
 */
function observeSettlement(
  ctx: RelayContext,
  which: 'markSent' | 'markFailure',
  transition: OutboxTransition,
  observation: SettlementObservation,
): void {
  if (observation.late && ctx.isClosing()) return;
  const observe = (record: () => void): void => {
    if (observation.late) {
      try {
        record();
      } catch {
        // A throwing observer must not surface as an unhandled rejection:
        // the sweep is over.
      }
    } else {
      record();
    }
  };
  if (transition.outcome === 'claim-lost') {
    observe(() => ctx.observer.overlap('claim-lost'));
    // Only a markSent blocks the key in time: the failure path already
    // blocked it before the markFailure write started.
    if (
      which === 'markSent' &&
      !observation.late &&
      observation.key !== undefined &&
      observation.lap !== undefined
    ) {
      observation.lap.block(observation.key);
    }
    return;
  }
  if (transition.outcome === 'not-pending' && transition.status === 'sent') {
    // `markSent`: the row was already sent; `markFailure`: this relay's
    // publish was invoked and the row is sent — a copy may have duplicated.
    observe(() => ctx.observer.overlap('duplicate'));
    return;
  }
  if (
    !observation.late &&
    transition.outcome === 'not-pending' &&
    transition.status === 'failed' &&
    observation.key !== undefined &&
    observation.lap !== undefined
  ) {
    // Another relay failed it meanwhile: it now blocks its key.
    observation.lap.block(observation.key);
  }
  if (
    which === 'markFailure' &&
    observation.madeFailed === true &&
    transition.outcome === 'applied'
  ) {
    if (!observation.late) ctx.budget.poisoned += 1;
    const topic = observation.topic;
    if (topic !== undefined) observe(() => ctx.observer.poisoned(topic));
  }
}

/**
 * Examines one row; answers why the sweep must end, or `undefined` to go on.
 */
async function examine(
  ctx: RelayContext,
  store: IOutboxStore,
  lap: OutboxLap,
  record: OutboxRecord,
): Promise<StoreSweepEnd | undefined> {
  const { options, budget, runtime } = ctx;
  const key =
    record.orderingKey !== undefined ? blockKey(record.tenantId, record.orderingKey) : undefined;
  if (key !== undefined) {
    if (lap.isBlocked(key)) return undefined;
    if (lap.capReached) {
      // A later row of this key may follow inside the lap: it must stay blocked.
      lap.block(key);
      return undefined;
    }
  }
  const now = runtime.now();
  if (record.availableAt > now) {
    // In backoff. Blocking the key keeps a later row from overtaking it.
    if (key !== undefined) lap.block(key);
    return undefined;
  }

  const claim = claimStateOf(record, now);
  if (claim !== undefined && now < claim.leaseUntil + options.maxClockSkewMs) {
    if (key !== undefined) lap.block(key);
    return undefined;
  }
  const decoded =
    claim === undefined
      ? { ok: false as const }
      : decodeOutboxRecord(record, options.maxEnvelopeBytes);
  if (claim === undefined || !decoded.ok) {
    budget.attempted += 1;
    if (key !== undefined) lap.block(key);
    let transition: OutboxTransition;
    try {
      transition = await bounded(ctx, options.storeTimeoutMs, 'markInvalid', () =>
        store.markInvalid(record.id, now),
      );
    } catch {
      return 'store-failure';
    }
    if (transition.outcome === 'applied') {
      budget.poisoned += 1;
      ctx.observer.poisoned(undefined);
    }
    return undefined;
  }

  const leaseUntil = runtime.now() + options.claimLeaseMs;
  let acquired: OutboxTransition;
  try {
    acquired = await bounded(ctx, options.storeTimeoutMs, 'claim', () =>
      store.claim(record.id, { claimVersion: claim.claimVersion, leaseUntil }),
    );
  } catch {
    if (key !== undefined) lap.block(key);
    return 'store-failure';
  }
  if (acquired.outcome !== 'applied') {
    if (
      key !== undefined &&
      (acquired.outcome === 'claim-lost' ||
        (acquired.outcome === 'not-pending' && acquired.status === 'failed'))
    )
      lap.block(key);
    return undefined;
  }
  const claimVersion = claim.claimVersion + 1;
  budget.attempted += 1;
  if (
    runtime.now() + options.publishTimeoutMs + options.storeTimeoutMs + options.maxClockSkewMs >
    leaseUntil
  ) {
    if (key !== undefined) lap.block(key);
    ctx.observer.overlap('fenced');
    return undefined;
  }

  const { topic } = decoded.row;
  // Set inside the bound `run` closure, which the budget refuses to invoke at
  // `remaining <= 0`: true exactly when the publish was actually invoked.
  let publishInvoked = false;
  let failure: { readonly error: unknown } | undefined;
  try {
    await bounded(ctx, options.publishTimeoutMs, 'publish', () => {
      publishInvoked = true;
      return publish(ctx, record, decoded.row);
    });
  } catch (error) {
    failure = { error };
  }

  if (failure === undefined) {
    budget.published += 1;
    ctx.observer.published(topic);
    const settle = boundedSettle(ctx, 'markSent', () =>
      store.markSent(record.id, {
        claimVersion,
        settledAt: runtime.now(),
        sentBy: `${ctx.instanceId}/${ctx.origin}`,
        deleteNow: options.retainSentMs === 0,
      }),
    );
    let transition: OutboxTransition;
    try {
      transition = await settle.bounded;
    } catch (error) {
      // Published but not marked: block the key so no later row of it is
      // published before the next lap re-reads this still-pending row.
      if (key !== undefined) lap.block(key);
      if (error instanceof RelayCallTimeoutError) {
        // The bound expired and the store's answer is still on its way:
        // observe it when it arrives. A late rejection is the same failure,
        // already booked.
        settle.store.then(
          (late) => observeSettlement(ctx, 'markSent', late, { late: true }),
          () => {},
        );
      }
      return 'store-failure';
    }
    observeSettlement(ctx, 'markSent', transition, {
      late: false,
      lap,
      ...(key !== undefined ? { key } : {}),
    });
    return undefined;
  }

  if (key !== undefined) lap.block(key);
  // A failure while the application stops writes nothing: it is not the row's.
  if (ctx.isClosing()) return 'closing';
  budget.failures += 1;
  ctx.observer.publishFailed(topic);
  const attempts = attemptsOf(record) + 1;
  const status = attempts >= options.maxAttempts ? 'failed' : 'pending';
  const backoff = Math.min(options.baseBackoffMs * 2 ** (attempts - 1), options.maxBackoffMs);
  const markFailure = (): Promise<OutboxTransition> =>
    store.markFailure(record.id, {
      claimVersion,
      attempts,
      lastError: lastErrorOf(failure.error),
      availableAt: now + backoff,
      status,
    });
  let transition: OutboxTransition;
  if (publishInvoked) {
    // The publish ran: the failure is that row's work, so the write runs
    // under its own bound even when a pause exhausted the sweep budget.
    const settle = boundedSettle(ctx, 'markFailure', markFailure);
    try {
      transition = await settle.bounded;
    } catch (error) {
      if (error instanceof RelayCallTimeoutError) {
        settle.store.then(
          (late) =>
            observeSettlement(ctx, 'markFailure', late, {
              late: true,
              topic,
              madeFailed: status === 'failed',
            }),
          () => {},
        );
      }
      return 'store-failure';
    }
  } else {
    // The budget refused the publish: keep today's path, which itself
    // refuses — no write, no attempt counted, the claim expires and the
    // next lap retries the row.
    try {
      transition = await bounded(ctx, options.storeTimeoutMs, 'markFailure', markFailure);
    } catch {
      return 'store-failure';
    }
  }
  observeSettlement(ctx, 'markFailure', transition, {
    late: false,
    lap,
    ...(key !== undefined ? { key } : {}),
    topic,
    madeFailed: status === 'failed',
  });
  return failure.error instanceof RelayCallTimeoutError ? 'deadline' : undefined;
}

/**
 * Sweeps one store: starts a lap when none is in progress (the ONLY place the
 * failed keys are read), then pages and examines rows until a budget runs out,
 * a store call fails, the outbox closes, or a short page ends the lap.
 *
 * @internal
 * @param ctx - The sweep's shared context and budget
 * @param store - The store to sweep
 * @param holder - The store's lap, resumed when one is in progress
 * @returns Why this store's part of the sweep ended
 */
export async function sweepStore(
  ctx: RelayContext,
  store: IOutboxStore,
  holder: LapHolder,
): Promise<StoreSweepEnd> {
  const { options, budget } = ctx;
  let lap = holder.lap;
  if (lap === undefined) {
    const stop = stopReason(ctx);
    if (stop !== undefined) return stop;
    let failed;
    try {
      failed = await bounded(ctx, options.storeTimeoutMs, 'failedKeys', () =>
        store.failedKeys(options.maxFailedScan),
      );
    } catch {
      return 'store-failure';
    }
    lap = new OutboxLap(failed, options.maxFailedScan);
    holder.lap = lap;
  }
  for (;;) {
    const stop = stopReason(ctx);
    if (stop !== undefined) return stop;
    const limit = Math.min(options.pageSize, options.scanLimit - budget.scanned);
    let page: readonly OutboxRecord[];
    const after = lap.cursor;
    try {
      page = await bounded(ctx, options.storeTimeoutMs, 'scanPending', () =>
        store.scanPending(after, limit),
      );
    } catch {
      return 'store-failure';
    }
    for (const record of page) {
      const rowStop = stopReason(ctx);
      if (rowStop !== undefined) return rowStop;
      budget.scanned += 1;
      lap.advance(record.position);
      const end = await examine(ctx, store, lap, record);
      if (end !== undefined) return end;
    }
    if (page.length < limit) {
      // Every pending row has been examined: the next sweep starts a new lap.
      holder.lastLapOverflowed = lap.blockedOverflow;
      holder.lap = undefined;
      return 'lap-complete';
    }
  }
}

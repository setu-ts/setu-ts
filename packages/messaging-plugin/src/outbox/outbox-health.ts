/**
 * The `outbox` health indicator (M107 §3.11).
 *
 * Cluster-wide reasons come from the STORE, so every replica reports them
 * identically and a load balancer may act on them: the oldest pending row's
 * age against `health.degradedAfterMs`, the failed-row count, and whether the
 * failed count reaches `relay.maxFailedScan` (a lap's blocked set is then
 * incomplete). Per-instance reasons come from this instance's own relay and
 * are labelled per-instance: a replica that never sweeps — every replica that
 * loses the scheduler's slot under a shared lock — reports none of them.
 * There is deliberately no per-instance "last sweep" staleness rule: under a
 * correct shared lock it would flap.
 *
 * `data` carries counts, ages in milliseconds, fixed reason names and the last
 * local sweep's counts — never a tenant id, an ordering key, a topic or error
 * text (§10 obligation 3).
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  IOutboxStore,
  IRuntimeServices,
  OutboxStoreStats,
} from '@setu-ts/common';
import { createCachedProbe } from '@setu-ts/common';

import type { OutboxCollector } from './outbox-collector.ts';
import type { OutboxInstanceSignals } from './outbox-service.ts';
import type { ResolvedOutboxOptions } from './options.ts';

/** Store-statistics cache lifetime, in ms (§3.11). */
const STATS_TTL_MS = 5000;

/** Per-read bound on the store statistics, in ms (§3.11). */
const STATS_TIMEOUT_MS = 2000;

/**
 * Why the indicator reports `degraded` — a fixed vocabulary.
 *
 * @internal
 */
export type OutboxHealthReason =
  | 'oldest-pending-age'
  | 'failed-rows'
  | 'failed-scan-cap'
  | 'blocked-key-cap'
  | 'store-write-failing'
  | 'scheduled-overlap';

/**
 * What the indicator reads.
 *
 * @internal
 */
export interface OutboxHealthSource {
  /** Every active store, or `undefined` before activation. */
  activeStores(): readonly IOutboxStore[] | undefined;
  /** Whether the outbox is closing. */
  readonly closing: boolean;
  /** This instance's per-instance signals. */
  instanceSignals(): OutboxInstanceSignals;
}

/**
 * Everything the indicator is built from.
 *
 * @internal
 */
export interface OutboxHealthDeps {
  readonly runtime: IRuntimeServices;
  readonly source: OutboxHealthSource;
  readonly options: ResolvedOutboxOptions;
  /** Receives every fresh store read, when metrics are registered. */
  readonly collector?: OutboxCollector;
}

/** The store statistics summed over every active store. */
interface AggregateStats {
  readonly pending: number;
  readonly failed: number;
  readonly oldestPendingCreatedAt: number | undefined;
  /** Some store's failed count reached `maxFailedScan` (laps are per store). */
  readonly failedScanCap: boolean;
}

/** Sums per-store statistics. */
function aggregate(
  all: readonly OutboxStoreStats[],
  maxFailedScan: number,
): AggregateStats {
  let pending = 0;
  let failed = 0;
  let oldest: number | undefined;
  let failedScanCap = false;
  for (const stats of all) {
    pending += stats.pending;
    failed += stats.failed;
    if (stats.failed >= maxFailedScan) failedScanCap = true;
    const at = stats.oldestPendingCreatedAt;
    if (at !== undefined && (oldest === undefined || at < oldest)) oldest = at;
  }
  return { pending, failed, oldestPendingCreatedAt: oldest, failedScanCap };
}

/**
 * Builds the outbox health indicator.
 *
 * Lifecycle truth first: before the store is resolved and verified, and once
 * the outbox is closing, it reports `down` with `ready: false` and reads
 * nothing. Otherwise it reads `stats()` from every store through a cached,
 * bounded probe (TTL 5000 ms, bound 2000 ms); a read that rejects or does not
 * answer reports `down` with `reachable: false`.
 *
 * @internal
 * @param deps - Runtime, the outbox, resolved options and the optional collector
 * @returns The indicator
 */
export function createOutboxHealthIndicator(deps: OutboxHealthDeps): HealthIndicatorFn {
  const { runtime, source, options, collector } = deps;
  const readStats = createCachedProbe<AggregateStats | undefined>({
    probe: async () => {
      const stores = source.activeStores() ?? [];
      const stats = aggregate(
        await Promise.all(stores.map((store) => store.stats())),
        options.maxFailedScan,
      );
      collector?.syncStats(stats.pending, oldestAge(runtime, stats));
      return stats;
    },
    fallback: undefined,
    ttlMs: STATS_TTL_MS,
    timeoutMs: STATS_TIMEOUT_MS,
    hrtime: () => runtime.hrtime(),
    setTimer: (fn, ms) => runtime.setTimeout(fn, ms),
    clearTimer: (handle) => runtime.clearTimeout(handle),
  });

  return async (): Promise<HealthCheckResult> => {
    if (source.activeStores() === undefined || source.closing) {
      return { status: 'down', data: { ready: false } };
    }
    const stats = await readStats();
    if (stats === undefined) {
      return { status: 'down', data: { ready: true, reachable: false } };
    }
    const age = oldestAge(runtime, stats);
    const signals = source.instanceSignals();
    const reasons: OutboxHealthReason[] = [];
    if (age !== undefined && age > options.degradedAfterMs) reasons.push('oldest-pending-age');
    if (stats.failed > 0) reasons.push('failed-rows');
    if (stats.failedScanCap) reasons.push('failed-scan-cap');
    if (signals.blockedKeyCap) reasons.push('blocked-key-cap');
    if (signals.storeWriteFailing) reasons.push('store-write-failing');
    if (signals.scheduledOverlap) reasons.push('scheduled-overlap');
    const last = signals.lastSweep;
    return {
      status: reasons.length > 0 ? 'degraded' : 'up',
      data: {
        ready: true,
        reachable: true,
        pending: stats.pending,
        failed: stats.failed,
        ...(age !== undefined ? { oldestPendingAgeMs: age } : {}),
        reasons,
        ...(last !== undefined
          ? {
            lastSweep: {
              origin: last.origin,
              scanned: last.scanned,
              published: last.published,
              failures: last.failures,
              poisoned: last.poisoned,
              endedBy: last.endedBy,
            },
          }
          : {}),
      },
    };
  };
}

/** The oldest pending row's age on the wall clock, never negative. */
function oldestAge(runtime: IRuntimeServices, stats: AggregateStats): number | undefined {
  const at = stats.oldestPendingCreatedAt;
  return at === undefined ? undefined : Math.max(0, runtime.now() - at);
}

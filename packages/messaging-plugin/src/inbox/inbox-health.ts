/**
 * The `inbox` health indicator (M108 §3.11).
 *
 * Lifecycle truth first: before the store is verified, and once the inbox has
 * closed, it reports `down` with `ready: false` and reads nothing. Otherwise
 * it reads `stats()` through a cached, bounded probe (TTL 5000 ms, bound 2000
 * ms): a rejection reports `down` with `reachable: false`; a read that does
 * not answer within the bound reports `up` with `reachable: 'unknown'` — a
 * slow count is not an outage (the messaging indicator's V5-2 rule), which
 * matters where the count is a scan.
 *
 * `data` carries the parked count only — never a consumer, a topic, an
 * envelope id or error text.
 *
 * @module
 */
import type { HealthCheckResult, HealthIndicatorFn, IRuntimeServices } from '@setu-ts/common';
import { createCachedProbe } from '@setu-ts/common';

import type { InboxService } from './inbox-service.ts';

/** Store-statistics cache lifetime, in ms. */
const STATS_TTL_MS = 5000;

/** Per-read bound on the store statistics, in ms. */
const STATS_TIMEOUT_MS = 2000;

/** What one bounded read produced. */
type StatsRead = { readonly parked: number } | 'unreachable' | 'timeout';

/**
 * Builds the inbox health indicator.
 *
 * @internal
 * @param runtime - The runtime the probe's clock and timers run on
 * @param service - The inbox it reports on
 * @returns The indicator
 */
export function createInboxHealthIndicator(
  runtime: IRuntimeServices,
  service: Pick<InboxService, 'activeStore'>,
): HealthIndicatorFn {
  const readStats = createCachedProbe<StatsRead>({
    probe: async () => {
      const store = service.activeStore();
      if (store === undefined) return 'unreachable';
      try {
        return { parked: (await store.stats()).parked };
      } catch {
        return 'unreachable';
      }
    },
    fallback: 'timeout',
    ttlMs: STATS_TTL_MS,
    timeoutMs: STATS_TIMEOUT_MS,
    hrtime: () => runtime.hrtime(),
    setTimer: (fn, ms) => runtime.setTimeout(fn, ms),
    clearTimer: (handle) => runtime.clearTimeout(handle),
  });

  return async (): Promise<HealthCheckResult> => {
    if (service.activeStore() === undefined) {
      return { status: 'down', data: { ready: false } };
    }
    const stats = await readStats();
    if (stats === 'unreachable') {
      return { status: 'down', data: { ready: true, reachable: false } };
    }
    if (stats === 'timeout') {
      return { status: 'up', data: { ready: true, reachable: 'unknown' } };
    }
    const reasons = stats.parked > 0 ? ['parked-rows'] : [];
    return {
      status: reasons.length > 0 ? 'degraded' : 'up',
      data: { ready: true, reachable: true, parked: stats.parked, reasons },
    };
  };
}

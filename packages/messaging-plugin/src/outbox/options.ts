/**
 * Outbox option resolution and validation (M107 §4.1).
 *
 * Every numeric option must be a finite integer in its range — `NaN` and a
 * fraction are refused (the M90a fail-open class) — and the refusal names the
 * option. `publishTimeoutMs + 2 * storeTimeoutMs >= sweepDeadlineMs` is
 * refused, because no row could ever start (the claim, the publish and the
 * status write must all fit, with headroom), and `claimLeaseMs` below
 * `publishTimeoutMs + 2 * storeTimeoutMs + maxClockSkewMs` is refused. All
 * refusals are synchronous: they run at
 * plugin construction, before any application starts.
 *
 * @module
 */
import { publishIdProblem } from '@setu-ts/common';

import type { OutboxOptions, OutboxStoreEntry } from '../interfaces/index.ts';
import { MAX_CLAIM_LEASE_MS, MAX_CLOCK_SKEW_MS } from './record-codec.ts';

/** The largest delay a runtime timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Every outbox option with its default applied.
 *
 * @internal
 */
export interface ResolvedOutboxOptions {
  readonly maxEnvelopeBytes: number;
  readonly background: ((promise: Promise<unknown>) => void) | undefined;
  readonly schedule: boolean;
  readonly intervalMs: number;
  readonly pageSize: number;
  readonly scanLimit: number;
  readonly publishLimit: number;
  readonly maxFailedScan: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly sweepDeadlineMs: number;
  readonly publishTimeoutMs: number;
  readonly storeTimeoutMs: number;
  readonly claimLeaseMs: number;
  readonly maxClockSkewMs: number;
  readonly degradedAfterMs: number;
  readonly overlapWindowMs: number;
  readonly retainSentMs: number;
  readonly purgeBatch: number;
  readonly purgeIntervalMs: number;
  /** One store, or a store per tenant id. */
  readonly stores:
    | { readonly kind: 'single'; readonly entry: OutboxStoreEntry }
    | { readonly kind: 'per-tenant'; readonly entries: ReadonlyMap<string, OutboxStoreEntry> };
}

/** Reads an integer option, refusing `NaN`, fractions and out-of-range values. */
function integer(
  name: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`outbox: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Whether a value is a store instance or a registry factory. */
function isStoreEntry(value: unknown): value is OutboxStoreEntry {
  return typeof value === 'function' || (typeof value === 'object' && value !== null);
}

/** Reads the store form: exactly one of `store` and `stores`. */
function resolveStores(options: OutboxOptions): ResolvedOutboxOptions['stores'] {
  const store: unknown = options.store;
  const stores: unknown = options.stores;
  if ((store === undefined) === (stores === undefined)) {
    throw new TypeError('outbox: supply exactly one of store and stores');
  }
  if (store !== undefined) {
    if (!isStoreEntry(store)) {
      throw new TypeError('outbox: store must be an IOutboxStore or a registry factory');
    }
    return { kind: 'single', entry: store };
  }
  if (typeof stores !== 'object' || stores === null || Array.isArray(stores)) {
    throw new TypeError('outbox: stores must be an object keyed by tenant id');
  }
  const entries = new Map<string, OutboxStoreEntry>();
  for (const [tenantId, entry] of Object.entries(stores)) {
    // The tenant id is never quoted: it may carry anything.
    if (publishIdProblem(tenantId) !== null) {
      throw new TypeError('outbox: a stores key is not a valid tenant id');
    }
    if (!isStoreEntry(entry)) {
      throw new TypeError(
        'outbox: each stores entry must be an IOutboxStore or a registry factory',
      );
    }
    entries.set(tenantId, entry);
  }
  if (entries.size === 0) throw new TypeError('outbox: stores must name at least one tenant');
  return { kind: 'per-tenant', entries };
}

/**
 * Validates the outbox options and applies their defaults.
 *
 * @internal
 * @param options - The `outbox` option arm
 * @returns The resolved options
 * @throws {RangeError} When a numeric option is out of range, or the per-call
 *   bounds leave no headroom in the sweep deadline
 * @throws {TypeError} When the store form or `background` is malformed
 */
export function resolveOutboxOptions(options: OutboxOptions): ResolvedOutboxOptions {
  const relay = options.relay ?? {};
  const health = options.health ?? {};
  if (options.background !== undefined && typeof options.background !== 'function') {
    throw new TypeError('outbox: background must be a function');
  }
  if (relay.schedule !== undefined && typeof relay.schedule !== 'boolean') {
    throw new TypeError('outbox: relay.schedule must be a boolean');
  }
  const baseBackoffMs = integer('relay.baseBackoffMs', relay.baseBackoffMs, 1000, 1, MAX_TIMER_MS);
  const sweepDeadlineMs = integer(
    'relay.sweepDeadlineMs',
    relay.sweepDeadlineMs,
    30_000,
    1,
    MAX_TIMER_MS,
  );
  const publishTimeoutMs = integer(
    'relay.publishTimeoutMs',
    relay.publishTimeoutMs,
    5000,
    1,
    MAX_TIMER_MS,
  );
  const storeTimeoutMs = integer(
    'relay.storeTimeoutMs',
    relay.storeTimeoutMs,
    5000,
    1,
    MAX_TIMER_MS,
  );
  if (publishTimeoutMs + 2 * storeTimeoutMs >= sweepDeadlineMs) {
    throw new RangeError(
      'outbox: relay.publishTimeoutMs + 2 * relay.storeTimeoutMs must be less than ' +
        'relay.sweepDeadlineMs, or no row could ever start',
    );
  }
  const claimLeaseMs = integer(
    'relay.claimLeaseMs',
    relay.claimLeaseMs,
    30_000,
    1,
    MAX_CLAIM_LEASE_MS,
  );
  const maxClockSkewMs = integer(
    'relay.maxClockSkewMs',
    relay.maxClockSkewMs,
    5000,
    0,
    MAX_CLOCK_SKEW_MS,
  );
  if (claimLeaseMs < publishTimeoutMs + 2 * storeTimeoutMs + maxClockSkewMs) {
    throw new RangeError(
      'outbox: relay.claimLeaseMs must cover relay.publishTimeoutMs + ' +
        '2 * relay.storeTimeoutMs + relay.maxClockSkewMs',
    );
  }
  return {
    maxEnvelopeBytes: integer('maxEnvelopeBytes', options.maxEnvelopeBytes, 262_144, 1, 67_108_864),
    background: options.background,
    schedule: relay.schedule ?? true,
    intervalMs: integer('relay.intervalMs', relay.intervalMs, 1000, 1, MAX_TIMER_MS),
    pageSize: integer('relay.pageSize', relay.pageSize, 100, 1, 10_000),
    scanLimit: integer('relay.scanLimit', relay.scanLimit, 1000, 1, 1_000_000),
    publishLimit: integer('relay.publishLimit', relay.publishLimit, 100, 1, 100_000),
    maxFailedScan: integer('relay.maxFailedScan', relay.maxFailedScan, 1000, 1, 1_000_000),
    maxAttempts: integer('relay.maxAttempts', relay.maxAttempts, 10, 1, 1000),
    baseBackoffMs,
    maxBackoffMs: integer(
      'relay.maxBackoffMs',
      relay.maxBackoffMs,
      Math.max(300_000, baseBackoffMs),
      baseBackoffMs,
      MAX_TIMER_MS,
    ),
    sweepDeadlineMs,
    publishTimeoutMs,
    storeTimeoutMs,
    claimLeaseMs,
    maxClockSkewMs,
    degradedAfterMs: integer(
      'health.degradedAfterMs',
      health.degradedAfterMs,
      60_000,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    overlapWindowMs: integer(
      'health.overlapWindowMs',
      health.overlapWindowMs,
      600_000,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    retainSentMs: integer(
      'retainSentMs',
      options.retainSentMs,
      7 * 24 * 60 * 60 * 1000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    purgeBatch: integer('purgeBatch', options.purgeBatch, 100, 1, 100_000),
    purgeIntervalMs: integer('purgeIntervalMs', options.purgeIntervalMs, 60_000, 1, MAX_TIMER_MS),
    stores: resolveStores(options),
  };
}

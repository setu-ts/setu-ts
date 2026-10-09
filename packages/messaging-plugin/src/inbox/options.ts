/**
 * Inbox option resolution and validation (M108 §3.11).
 *
 * Every numeric option must be a finite integer in its range — `NaN` and a
 * fraction are refused (the M90a fail-open class) — and the refusal names the
 * option. All refusals are synchronous: they run at plugin construction,
 * before any application starts.
 *
 * @module
 */
import type { InboxOptions, InboxStoreEntry } from '../interfaces/index.ts';

/** The largest delay a runtime timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/** Seven days, the default retention. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every inbox option with its default applied.
 *
 * @internal
 */
export interface ResolvedInboxOptions {
  readonly store: InboxStoreEntry;
  readonly maxAttempts: number | undefined;
  readonly retainMs: number;
  readonly storeTimeoutMs: number;
  readonly maxParkedEnvelopeBytes: number;
  readonly schedule: boolean;
  readonly purgeIntervalMs: number;
  readonly purgeBatch: number;
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
    throw new RangeError(`inbox: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validates the inbox options and applies their defaults.
 *
 * @internal
 * @param options - The `inbox` option arm
 * @returns The resolved options
 * @throws {RangeError} When a numeric option is out of range
 * @throws {TypeError} When the store or `purge.schedule` is malformed
 */
export function resolveInboxOptions(options: InboxOptions): ResolvedInboxOptions {
  const store: unknown = options.store;
  if (typeof store !== 'function' && (typeof store !== 'object' || store === null)) {
    throw new TypeError('inbox: store must be an IInboxStore or a registry factory');
  }
  const purge = options.purge ?? {};
  if (purge.schedule !== undefined && typeof purge.schedule !== 'boolean') {
    throw new TypeError('inbox: purge.schedule must be a boolean');
  }
  return {
    store: options.store,
    maxAttempts: options.maxAttempts === undefined
      ? undefined
      : integer('maxAttempts', options.maxAttempts, 0, 1, 1000),
    retainMs: integer('retainMs', options.retainMs, SEVEN_DAYS_MS, 60_000, Number.MAX_SAFE_INTEGER),
    storeTimeoutMs: integer('storeTimeoutMs', options.storeTimeoutMs, 5000, 1, MAX_TIMER_MS),
    maxParkedEnvelopeBytes: integer(
      'maxParkedEnvelopeBytes',
      options.maxParkedEnvelopeBytes,
      262_144,
      0,
      67_108_864,
    ),
    schedule: purge.schedule ?? true,
    purgeIntervalMs: integer('purge.intervalMs', purge.intervalMs, 60_000, 1, MAX_TIMER_MS),
    purgeBatch: integer('purge.batch', purge.batch, 100, 1, 100_000),
  };
}

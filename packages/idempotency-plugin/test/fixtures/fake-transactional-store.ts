/**
 * A configurable fake `ITransactionalIdempotencyStore` for the tier-C unit
 * tests (M109b §3.3). Each member defaults to the happy path and can be
 * overridden per test, so a store-side rejection is driven exactly.
 *
 * @module
 */
import type {
  ITransactionalIdempotencyStore,
  TransactionalIdempotencyClaim,
  TransactionalIdempotencyRecord,
} from '@setu-ts/common';

/** One injected behaviour; anything left out keeps the happy path. */
export interface FakeTransactionalStoreOverrides {
  /** Overrides `find`. */
  readonly find?: (id: string) => Promise<TransactionalIdempotencyRecord | undefined>;
  /** Overrides `run`. */
  readonly run?: <R>(
    claim: TransactionalIdempotencyClaim,
    work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
  ) => Promise<R>;
  /** Overrides `purge`. */
  readonly purge?: (before: number, limit: number) => Promise<number>;
  /** Overrides `verify`. */
  readonly verify?: () => Promise<void>;
}

/** The default `run`: execute the work and return its value. */
function defaultRun<R>(
  _claim: TransactionalIdempotencyClaim,
  work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
): Promise<R> {
  return work({}).then((outcome) => outcome.value);
}

/**
 * Builds a fake store.
 *
 * @param overrides - The behaviours to override
 * @returns The fake store
 */
export function fakeTransactionalStore(
  overrides: FakeTransactionalStoreOverrides = {},
): ITransactionalIdempotencyStore {
  return {
    find: overrides.find ?? (() => Promise.resolve(undefined)),
    run: overrides.run ?? defaultRun,
    purge: overrides.purge ?? (() => Promise.resolve(0)),
    verify: overrides.verify ?? (() => Promise.resolve()),
  };
}

/** A committed record for a fingerprint and result. */
export function recordWith(
  fingerprint: string,
  result: string,
  overrides: Partial<TransactionalIdempotencyRecord> = {},
): TransactionalIdempotencyRecord {
  return {
    id: 'a'.repeat(64),
    fingerprint,
    result,
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

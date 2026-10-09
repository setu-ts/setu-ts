/**
 * The tier-C `within` algorithm (M109b §3.3).
 *
 * It is the M108 inbox algorithm — pre-read, write first, re-read after a
 * rejection — applied to plain code instead of a broker delivery:
 *
 * 1. validate the options (no store call on a bad key or fingerprint);
 * 2. derive the id and the fingerprint, and read the clock;
 * 3. pre-read: a committed record replays, or answers `fingerprint-mismatch`;
 * 4. one transaction creates the claim, runs the work, encodes the result and
 *    creates the result row, then commits;
 * 5. on a store-side rejection, re-read and decide: replay, mismatch,
 *    `conflict` (a retryable `409`) or `store-failed`.
 *
 * A `fn` error is TAGGED and rethrown unchanged, and a store error is never
 * rethrown verbatim — its driver message can quote the result (M108 F1).
 *
 * @module
 */
import type {
  IdempotentWithinOptions,
  IdempotentWithinResult,
  ILogger,
  IRuntimeServices,
  ITransactionalIdempotencyStore,
  TransactionalIdempotencyClaim,
  TransactionalIdempotencyRecord,
} from '@setu-ts/common';
import {
  DuplicateKeyError,
  httpStatusHintOf,
  resolveProbeTiming,
  withDeadline,
} from '@setu-ts/common';
import { errorKind } from '../core/error-kind.ts';
import { canonicalJson } from '../core/fingerprint.ts';
import { deriveHash } from '../core/hash.ts';
import { safeLog } from '../core/safe-log.ts';
import { IdempotencyWithinError } from '../errors.ts';
import { decodeResult, encodeResult } from './result-codec.ts';
import { resolveWithinOptions } from './within-options.ts';

/** Everything a `within` call needs, resolved once the store is active. */
export interface WithinDeps {
  /** The transactional store. */
  readonly store: ITransactionalIdempotencyStore;
  /** The runtime services (clock, subtle). */
  readonly runtime: IRuntimeServices;
  /** The logger thunk, read at call time. */
  readonly logger: () => ILogger | undefined;
  /** Default record eligibility age. */
  readonly ttlMs: number;
  /** Bound on each store call except the transaction itself. */
  readonly storeTimeoutMs: number;
  /** Largest storable result in UTF-8 bytes. */
  readonly maxResultBytes: number;
}

/** The maximum cause hops {@linkcode isConflict} walks. */
const MAX_CAUSE_DEPTH = 5;

/** A `fn` error, tagged so a store-side failure is never confused with it. */
class WithinFnError {
  readonly thrown: unknown;

  constructor(thrown: unknown) {
    this.thrown = thrown;
  }
}

/** Runs one store call under the store timeout, as a `'store-failed'` on expiry. */
function bounded<T>(
  deps: WithinDeps,
  run: () => Promise<T>,
  what: string,
): Promise<T> {
  return withDeadline(() => run(), {
    timeoutMs: deps.storeTimeoutMs,
    onTimeout: () =>
      new IdempotencyWithinError(
        'store-failed',
        `idempotency: the transactional store did not answer while ${what}`,
      ),
    timing: resolveProbeTiming(deps.runtime),
  });
}

/**
 * Reads a record, treating a failing read as absent (and logging it by class
 * only, never by message).
 */
async function readRecord(
  deps: WithinDeps,
  id: string,
): Promise<TransactionalIdempotencyRecord | undefined> {
  try {
    return await bounded(deps, () => deps.store.find(id), 'reading a record');
  } catch (error) {
    safeLog(deps.logger, 'warn', 'idempotency: within could not read the transactional store', {
      errorKind: errorKind(error),
    });
    return undefined;
  }
}

/** Decides whether a store rejection means "another call holds this key". */
function isConflict(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth <= MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null;
    depth++
  ) {
    if (current instanceof DuplicateKeyError) return true;
    if (httpStatusHintOf(current)?.status === 409) return true;
    let cause: unknown;
    try {
      cause = (current as { readonly cause?: unknown }).cause;
    } catch {
      return false;
    }
    current = cause;
  }
  return false;
}

/** A committed record's outcome, refusing a differing fingerprint. */
function replay<R>(
  record: TransactionalIdempotencyRecord,
  fingerprint: string,
): IdempotentWithinResult<R> {
  if (record.fingerprint !== fingerprint) {
    throw new IdempotencyWithinError(
      'fingerprint-mismatch',
      'idempotency: the key was used with a different fingerprint',
    );
  }
  return { value: decodeResult(record.result) as R, replayed: true };
}

/** Re-reads after a store-side rejection and decides the caller's outcome. */
async function recover<R>(
  deps: WithinDeps,
  id: string,
  fingerprint: string,
  failure: unknown,
): Promise<IdempotentWithinResult<R>> {
  const record = await readRecord(deps, id);
  if (record !== undefined) return replay<R>(record, fingerprint);
  if (isConflict(failure)) {
    throw new IdempotencyWithinError(
      'conflict',
      'idempotency: another call holds this key; retry',
    );
  }
  safeLog(deps.logger, 'warn', 'idempotency: the within store write failed', {
    errorKind: errorKind(failure),
  });
  throw new IdempotencyWithinError('store-failed', 'idempotency: the transactional store failed');
}

/**
 * Runs `fn` and its idempotency record in one transaction (M109b §3.3).
 *
 * @typeParam R - The work's result type, unconstrained
 * @typeParam S - The caller's annotation of the transaction scope, unchecked
 * @param deps - The resolved store, runtime and bounds
 * @param options - The key, namespace, scope, fingerprint and TTL
 * @param fn - The work, given the transaction's scope
 * @returns The value and whether it was replayed
 * @throws {IdempotencyWithinError} Refusing the options, or a store failure
 */
export async function runWithin<R, S>(
  deps: WithinDeps,
  options: IdempotentWithinOptions,
  fn: (scope: S) => Promise<R>,
): Promise<IdempotentWithinResult<R>> {
  const resolved = resolveWithinOptions(options, { ttlMs: deps.ttlMs });

  let fingerprintJson: string;
  try {
    fingerprintJson = canonicalJson(resolved.fingerprint ?? null);
  } catch {
    throw new IdempotencyWithinError(
      'fingerprint-invalid',
      'idempotency: the within fingerprint cannot be serialised',
    );
  }

  const subtle = deps.runtime.subtle;
  const [id, fingerprint] = await Promise.all([
    deriveHash(subtle, ['within', resolved.namespace, resolved.scope, resolved.key]),
    deriveHash(subtle, ['within-fp', fingerprintJson]),
  ]);

  const existing = await readRecord(deps, id);
  if (existing !== undefined) return replay<R>(existing, fingerprint);

  const now = deps.runtime.now();
  const claim: TransactionalIdempotencyClaim = {
    id,
    fingerprint,
    createdAt: now,
    expiresAt: now + resolved.ttlMs,
  };
  try {
    const value = await deps.store.run(claim, async (scope) => {
      let produced: R;
      try {
        produced = await fn(scope as S);
      } catch (error) {
        throw new WithinFnError(error);
      }
      const result = encodeResult(produced, deps.maxResultBytes);
      return { result, value: produced };
    });
    return { value, replayed: false };
  } catch (error) {
    // `fn`'s own error belongs to the application and stays unchanged.
    if (error instanceof WithinFnError) throw error.thrown;
    // A refusal from step 4 (an oversized or unserialisable result): unchanged.
    if (error instanceof IdempotencyWithinError) throw error;
    return await recover<R>(deps, id, fingerprint, error);
  }
}

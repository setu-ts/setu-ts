/**
 * The shared backend capability primitives for the record-first stores: M107's
 * outbox, M108's inbox and M109b's tier-C idempotency store (plan §3.6, §11.1).
 *
 * All three stores must answer the same question at startup — "can this
 * backend write an idempotency/marker record FIRST, inside the caller's
 * transaction, and roll it back?" — so the mechanism lives here once. It is
 * deliberately NOT the whole of each store's `verify()`: the three stores
 * refuse DIFFERENT sets of backends (the outbox supports Cosmos; the inbox and
 * the tier-C store do not), so each keeps its own `reason` vocabulary and
 * applies these primitives to it. One implementation of the probe, three
 * refusal policies.
 *
 * **Internal — not exported from the package barrel.**
 *
 * @module
 */
import type { EntityKey } from '@setu-ts/common';
import { BigtableAdapter } from '../adapters/bigtable/bigtable-adapter.ts';
import { CosmosAdapter } from '../adapters/cosmos/cosmos-adapter.ts';
import type { IDatabaseService } from '../interfaces/index.ts';
import { adapterInfoOf } from '../services/database-service.ts';

/**
 * MongoDB's server code for "transactions need a replica set".
 *
 * @internal
 */
export const MONGO_ILLEGAL_OPERATION = 20;

/**
 * Thrown inside a startup probe so its transaction always rolls back. Identity
 * (`error === rollback`) is the success signal, so a probe that rolled back is
 * never confused with a backend refusal.
 *
 * @internal
 */
export class ProbeRollback extends Error {
  /** @inheritdoc */
  override readonly name = 'ProbeRollback';

  /**
   * @param message - A message naming the store being probed
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Whether the configured backend is Cosmos DB, by adapter arm or by adapter
 * class (so a shipped adapter handed to the `'custom'` arm is still refused).
 *
 * @internal
 * @param service - The database service a store bridge resolved
 * @returns `true` when the backend is Cosmos DB (or an `IDatabaseService` this
 *   package did not build, which reports no adapter)
 */
export function isCosmosBackend(service: IDatabaseService): boolean {
  const info = adapterInfoOf(service);
  return info?.type === 'cosmos' || info?.adapter instanceof CosmosAdapter;
}

/**
 * Whether the configured backend is Bigtable, by adapter arm or by adapter
 * class.
 *
 * @internal
 * @param service - The database service a store bridge resolved
 * @returns `true` when the backend is Bigtable
 */
export function isBigtableBackend(service: IDatabaseService): boolean {
  const info = adapterInfoOf(service);
  return info?.type === 'bigtable' || info?.adapter instanceof BigtableAdapter;
}

/**
 * Whether one error is the server's measured standalone-MongoDB refusal: code
 * `20`, `codeName: 'IllegalOperation'`.
 *
 * Read guarded, since a cause is foreign — a `code` getter that throws is a
 * refusal of another kind, not a replica-set one.
 *
 * @internal
 * @param member - One error from a bounded cause chain
 * @returns `true` for the standalone refusal
 */
export function isMongoReplicaSetRefusal(member: object): boolean {
  try {
    const candidate = member as { code?: unknown; codeName?: unknown };
    return candidate.code === MONGO_ILLEGAL_OPERATION &&
      candidate.codeName === 'IllegalOperation';
  } catch {
    return false;
  }
}

/**
 * Runs a two-create transaction that ALWAYS rolls back, so a store can refuse
 * at startup a backend that cannot write a record-first record.
 *
 * The probe is what reaches a standalone MongoDB (whose refusal surfaces only
 * at the first operation inside a transaction) and a custom adapter bounded to
 * one row per transaction. Nothing it writes survives: the transaction is
 * rolled back, and the deferred backends send nothing.
 *
 * @internal
 * @param service - The database service the store writes through
 * @param entity - The entity the two rows are created in
 * @param rows - The two rows to create, in order
 * @param rollback - The error thrown to force the rollback
 * @returns A promise resolved once the transaction rolled back
 */
export async function probeTwoCreateTransaction(
  service: IDatabaseService,
  entity: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  rollback: Error,
): Promise<void> {
  await service.transaction(async (uow) => {
    const repo = uow.getRepository<Record<string, unknown>, EntityKey>(entity);
    for (const row of rows) await repo.create(row);
    throw rollback;
  });
}

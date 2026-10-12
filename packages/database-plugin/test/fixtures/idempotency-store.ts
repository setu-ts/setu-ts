/**
 * Shared fixtures for the tier-C idempotency store bridge tests (M109b): a real
 * `DatabaseService` over `MemoryAdapter`, claim builders, and direct row access
 * for seeding and reading back.
 *
 * @module
 */
import type { EntityKey, TransactionalIdempotencyClaim } from '@setu-ts/common';
import { DatabaseService, MemoryAdapter } from '../../src/index.ts';
import type { DatabaseAdapterType, IDatabaseService } from '../../src/interfaces/index.ts';
import { DatabaseIdempotencyStore } from '../../src/idempotency/database-idempotency-store.ts';

/** The entity every bridge test uses. */
export const ENTITY = 'Idempotency';

/** The result-row suffix (kept in the test so a change to it is caught). */
export const RESULT_SUFFIX = '.r';

/**
 * A connected memory-backed database service, labelled with `type` so the
 * startup check's adapter-type refusals can be driven without the backend.
 */
export async function memoryService(
  type: DatabaseAdapterType = 'memory',
): Promise<IDatabaseService> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  return new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), type);
}

/** A bridge over `service` with a deterministic probe id. */
export function storeOver(service: IDatabaseService): DatabaseIdempotencyStore {
  let n = 0;
  return new DatabaseIdempotencyStore(service, ENTITY, () => `probe-${++n}`);
}

/** A claim for a short label. */
export function claim(
  label: string,
  overrides: Partial<TransactionalIdempotencyClaim> = {},
): TransactionalIdempotencyClaim {
  return {
    id: label.padEnd(64, '0'),
    fingerprint: 'f'.repeat(64),
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

/** Writes rows directly (outside the bridge), the way any other writer could. */
export async function seed(
  service: IDatabaseService,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const repo = service.getRepository<Record<string, unknown>, EntityKey>(ENTITY);
  for (const row of rows) await repo.create(row);
}

/** Every stored row of the entity, read without the bridge. */
export function allRows(service: IDatabaseService): Promise<Record<string, unknown>[]> {
  return service.getRepository<Record<string, unknown>, EntityKey>(ENTITY).findAll();
}

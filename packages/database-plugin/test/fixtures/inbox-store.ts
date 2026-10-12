/**
 * Shared fixtures for the inbox store bridge tests (M108): a real
 * `DatabaseService` over `MemoryAdapter`, record builders, and direct row
 * access for seeding and reading back.
 *
 * @module
 */
import type { EntityKey, InboxIds, InboxRecord } from '@setu-ts/common';
import { INBOX_RECORD_KIND } from '@setu-ts/common';
import { DatabaseService, MemoryAdapter } from '../../src/index.ts';
import type { DatabaseAdapterType, IDatabaseService } from '../../src/interfaces/index.ts';
import { DatabaseInboxStore } from '../../src/inbox/database-inbox-store.ts';

/** The entity every bridge test uses. */
export const ENTITY = 'Inbox';

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
export function storeOver(service: IDatabaseService): DatabaseInboxStore {
  let n = 0;
  return new DatabaseInboxStore(service, ENTITY, () => `probe-${++n}`);
}

/** The two row ids for a short label. */
export function idsFor(label: string): InboxIds {
  const marker = label.padEnd(64, '0');
  return { marker, attempts: `${marker}.attempts` };
}

/** A marker record with every required field. */
export function marker(label: string, overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: idsFor(label).marker,
    kind: INBOX_RECORD_KIND,
    consumer: 'payroll',
    topic: 'people.hired.v1',
    status: 'processed',
    attempts: 0,
    updatedAt: 1_000,
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

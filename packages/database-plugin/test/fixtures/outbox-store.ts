/**
 * Shared fixtures for the outbox store bridge tests (M107): a real
 * `DatabaseService` over `MemoryAdapter`, a record builder, and a recording
 * wrapper that captures every repository call the bridge issues.
 *
 * @module
 */
import type { EntityKey, OutboxRecord } from '@setu-ts/common';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';
import { DatabaseService, MemoryAdapter } from '../../src/index.ts';
import type { IDatabaseService, IRepository, IUnitOfWork } from '../../src/interfaces/index.ts';

/** The entity every bridge test uses. */
export const ENTITY = 'Outbox';

/** A connected memory-backed database service. */
export async function memoryService(): Promise<IDatabaseService> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  return new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'memory');
}

/**
 * A pending outbox record with every required field. `seq` orders `position`
 * and derives the id, so `record(1)` sorts before `record(2)`.
 */
export function record(seq: number, overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  const hex = seq.toString(16).padStart(32, '0');
  return {
    id: `row-${seq}`,
    kind: OUTBOX_RECORD_KIND,
    topic: 'orders.placed.v1',
    envelope: JSON.stringify({ id: `row-${seq}` }),
    options: JSON.stringify({ deduplicationId: `row-${seq}` }),
    position: `${String(1_000 + seq).padStart(15, '0')}${hex}`,
    createdAt: 1_000 + seq,
    status: 'pending',
    attempts: 0,
    availableAt: 1_000 + seq,
    claimVersion: 0,
    leaseUntil: 0,
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

/** One recorded repository call. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Wraps a database service so every repository call (outside or inside a
 * transaction) is recorded, then forwarded to the real repository.
 */
export function recordingService(
  inner: IDatabaseService,
): { service: IDatabaseService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const wrap = <E, Id extends EntityKey>(repo: IRepository<E, Id>): IRepository<E, Id> =>
    new Proxy(repo, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const service: IDatabaseService = {
    getRepository: <E, Id extends EntityKey = string>(entity: string) =>
      wrap(inner.getRepository<E, Id>(entity)),
    transaction: <T>(work: (uow: IUnitOfWork) => Promise<T>) => {
      calls.push({ method: 'transaction', args: [] });
      return inner.transaction((uow) =>
        work({
          getRepository: <E, Id extends EntityKey = string>(e: string) =>
            wrap(uow.getRepository<E, Id>(e)),
        })
      );
    },
    query: (sql, params) => inner.query(sql, params),
    migrate: () => inner.migrate(),
    isHealthy: () => inner.isHealthy(),
    close: () => inner.close(),
  };
  return { service, calls };
}

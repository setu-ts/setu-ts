/**
 * The outbox bridge's column mapping (M107 §3.2): a record round-trips through
 * a real memory `DatabaseService`, `kind` is written on every row, absent
 * optional fields are stored as `null` and read back as absent, and an
 * adapter's extra columns never reach the record.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';
import type { OutboxRecord } from '@setu-ts/common';
import { DatabaseOutboxStore } from '../../../src/outbox/database-outbox-store.ts';
import { allRows, ENTITY, memoryService, record, seed } from '../../fixtures/outbox-store.ts';

describe('DatabaseOutboxStore — column mapping', () => {
  it('writes kind and stores each absent optional field as null', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    // A record whose kind is forged at runtime: the bridge stamps its own.
    const forged = { ...record(1), kind: 'business' } as unknown as OutboxRecord;

    await service.transaction((uow) => store.append(uow, forged));

    const [row] = await allRows(service);
    expect(row.kind).toBe(OUTBOX_RECORD_KIND);
    for (const field of ['orderingKey', 'tenantId', 'traceparent', 'lastError', 'settledAt']) {
      expect(row[field]).toBeNull();
    }
    expect(row.sentBy).toBeNull();
  });

  it('reads a record back with optional fields omitted, never null', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await service.transaction((uow) => store.append(uow, record(1)));

    const [read] = await store.scanPending(undefined, 10);

    expect(read).toEqual(record(1));
    expect(Object.hasOwn(read, 'tenantId')).toBe(false);
    expect(Object.hasOwn(read, 'settledAt')).toBe(false);
  });

  it('round-trips every optional field when present', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    const full = record(1, {
      orderingKey: 'order-1',
      tenantId: 'acme',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      lastError: 'broker down',
    });
    await service.transaction((uow) => store.append(uow, full));

    expect(await store.scanPending(undefined, 10)).toEqual([full]);
  });

  it('drops a column that is not an outbox field', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await seed(service, [{ ...record(1), _etag: 'abc', tenantId: null }]);

    const [read] = await store.scanPending(undefined, 10);

    expect(Object.hasOwn(read, '_etag')).toBe(false);
    expect(read).toEqual(record(1));
  });

  it('writes inside the caller transaction, so a throw rolls the row back', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);

    const failed = await service.transaction(async (uow) => {
      await store.append(uow, record(1));
      throw new Error('business write failed');
    }).catch((error: unknown) => error);

    expect((failed as Error).message).toBe('business write failed');
    expect(await allRows(service)).toEqual([]);
  });
});

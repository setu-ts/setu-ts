import { describe, expect, it, vi } from 'vitest';
import { DuplicateKeyError } from '@setu-ts/common';
import {
  createMigrationLedger,
  DatabaseService,
  MemoryAdapter,
  MIGRATION_LEDGER_ENTITY,
  MigrationLedgerError,
} from '../../src/index.ts';

async function memoryDatabase(): Promise<DatabaseService> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  return new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'memory');
}

describe('migration ledger', () => {
  it('records, projects names, rejects duplicates, and removes idempotently on memory', async () => {
    const database = await memoryDatabase();
    try {
      const ledger = createMigrationLedger(database);
      expect(await ledger.applied()).toEqual([]);
      await ledger.record('one', '2026-10-19T00:00:00.000Z');
      expect(await ledger.applied()).toEqual(['one']);
      expect(await database.getRepository(MIGRATION_LEDGER_ENTITY).findById('one')).toEqual({
        id: 'one',
        appliedAt: '2026-10-19T00:00:00.000Z',
      });
      await expect(ledger.record('one', 'later')).rejects.toBeInstanceOf(DuplicateKeyError);
      await ledger.remove('one');
      await ledger.remove('one');
      expect(await ledger.applied()).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('honors the entity override and reads only 10001 ids', async () => {
    const database = await memoryDatabase();
    const repository = database.getRepository<{ id: string }>('history');
    vi.spyOn(database, 'getRepository').mockReturnValue(repository);
    const read = vi.spyOn(repository, 'findAll').mockResolvedValue([{ id: 'one' }]);
    const ledger = createMigrationLedger(database, { entity: 'history' });
    expect(await ledger.applied()).toEqual(['one']);
    expect(read).toHaveBeenCalledWith({ select: ['id'], limit: 10_001 });
    read.mockResolvedValue(Array.from({ length: 10_001 }, (_, i) => ({ id: String(i) })));
    await expect(ledger.applied()).rejects.toMatchObject({
      name: 'MigrationLedgerError',
      reason: 'oversized',
    });
    await expect(ledger.applied()).rejects.toBeInstanceOf(MigrationLedgerError);
    read.mockResolvedValue(Array.from({ length: 10_000 }, (_, i) => ({ id: String(i) })));
    expect(await ledger.applied()).toHaveLength(10_000);
    await database.close();
  });

  it.each(['', '   ', 42, null])(
    'refuses an invalid entity without echoing it (%s)',
    async (entity) => {
      const database = await memoryDatabase();
      expect(() => createMigrationLedger(database, { entity: entity as string })).toThrow(
        'MigrationLedgerOptions.entity must be a non-empty string',
      );
      await database.close();
    },
  );
});

import { expect, it } from 'vitest';
import { encodeCursor, InvalidCursorError, PrimaryKeyChangeError } from '@setu-ts/common';
import { createD1DataSource } from '../../src/database/d1-data-source.ts';
import { SqliteD1 } from '../d1-fakes.ts';
import { D1Adapter } from '../../src/database/d1-adapter.ts';

for (const transactional of [false, true]) {
  for (const safeReads of [1, 2]) {
    it(`D1 ${transactional ? 'transaction' : 'direct'} update snapshots a getter payload once (${safeReads} safe reads)`, async () => {
      const adapter = new D1Adapter(
        new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)'),
        { tables: { User: { table: 'users' } } },
      );
      await adapter.connect();
      const committed = adapter.createDataSource('User');
      await committed.create({ id: '5', name: 'before' });
      const tx = transactional ? await adapter.beginTransaction() : undefined;
      try {
        let reads = 0;
        const updated = await (tx?.createDataSource('User') ?? committed).update('5', {
          get id() {
            reads += 1;
            return reads <= safeReads ? '5' : 'private-new';
          },
          name: 'after',
        });
        expect(updated).toEqual({ id: '5', name: 'after' });
        await tx?.commit();
        expect(await committed.findById('5')).toEqual({ id: '5', name: 'after' });
        expect(await committed.findById('private-new')).toBeNull();
        expect(reads).toBe(1);
      } catch (error) {
        await tx?.rollback().catch(() => {});
        throw error;
      } finally {
        await adapter.disconnect();
      }
    });
  }
}

it('D1 refuses changed primary keys on real SQLite and leaves the row unmoved', async () => {
  const source = createD1DataSource(
    new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)'),
    { table: 'users', primaryKey: ['id'] },
  );
  await source.create({ id: '5', name: 'before' });
  await expect(source.update('5', { id: 'private-new', name: 'after' })).rejects.toBeInstanceOf(
    PrimaryKeyChangeError,
  );
  await expect(
    source.updateWhere!('5', { name: 'before' }, { id: 'private-new' }),
  ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
  expect(await source.findById('5')).toEqual({ id: '5', name: 'before' });
  expect(await source.findById('private-new')).toBeNull();
});

it('D1 cursor content errors are InvalidCursorError', async () => {
  const source = createD1DataSource(new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY)'), {
    table: 'users',
    primaryKey: ['id'],
  });
  for (const cursor of [
    'private-token',
    encodeCursor({ orderedValues: ['5'], keyValues: ['5'], sortFingerprint: 'private-sort' }),
    encodeCursor({ orderedValues: [], keyValues: [], sortFingerprint: '' }),
  ]) {
    await expect(
      source.findPage!({ where: {}, orderBy: {}, select: [], limit: 1, offset: 0, cursor }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  }
});

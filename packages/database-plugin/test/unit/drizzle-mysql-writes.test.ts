import { describe, expect, it } from 'vitest';
import { createDrizzleDataSource } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { mysqlDrizzle } from '../fixtures/mysql-drizzle.ts';
import { operators } from '../fixtures/conditional-sources.ts';

describe('Drizzle MySQL affected-row writes', () => {
  for (const shape of ['tuple', 'bare'] as const) {
    it(`reads every ${shape} write back and reports conditional misses`, async () => {
      const fixture = mysqlDrizzle(shape);
      const source = createDrizzleDataSource(
        fixture.db,
        'user',
        { user: fixture.table },
        operators,
      );
      expect(await source.create({ id: 'a', name: 'old', version: 1 })).toEqual({
        id: 'a',
        name: 'old',
        version: 1,
      });
      expect(await source.update('a', { name: 'new' })).toMatchObject({ name: 'new' });
      expect(await source.updateWhere!('a', { version: 1 }, { version: 2 })).toMatchObject({
        version: 2,
      });
      expect(await source.findById('a')).toMatchObject({ version: 2 });
      expect(await source.updateWhere!('a', { version: 1 }, { name: 'bad' })).toBeNull();
      expect(await source.deleteWhere!('a', { version: 1 })).toBe(false);
      expect(await source.deleteWhere!('a', { version: 2 })).toBe(true);
      expect(await source.delete('a')).toBe(false);
      await expect(source.update('a', { name: 'bad' })).rejects.toThrow(/not found/);
      expect(fixture.transactions).toBe(5);
    });
  }
  it('names the MySQL read-back when a create finds no row after its insert', async () => {
    const fixture = mysqlDrizzle();
    // A read-back that finds nothing: the row vanished between the insert and the read.
    const db = {
      ...fixture.db,
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as typeof fixture.db;
    db.transaction = async (run) => await run(db);
    const source = createDrizzleDataSource(db, 'user', { user: fixture.table }, operators);
    await expect(source.create({ id: 'a', name: 'old' })).rejects.toThrow(
      /returned no row: RETURNING produced none, or on MySQL the read-back by key found none/,
    );
  });
  it('reads a plain no-op update back even when the driver reports changed rows', async () => {
    const fixture = mysqlDrizzle();
    const source = createDrizzleDataSource(fixture.db, 'user', { user: fixture.table }, operators);
    await source.create({ id: 'a', name: 'old' });
    fixture.changedOnly = true;
    expect(await source.update('a', { name: 'old' })).toEqual({ id: 'a', name: 'old' });
    expect(await source.updateWhere!('a', { name: 'old' }, { name: 'old' })).toBeNull();
  });
  it('rejects unknown counts inside the transaction and rolls the write back', async () => {
    const fixture = mysqlDrizzle('unknown');
    const source = createDrizzleDataSource(fixture.db, 'user', { user: fixture.table }, operators);
    await expect(source.create({ id: 'a', name: 'old' })).rejects.toBeInstanceOf(
      UnsupportedQueryFeatureError,
    );
    expect(await source.findById('a')).toBeNull();
  });
  it('uses generated column-primary keys, refuses unknown defaults before sending, and propagates transaction failures', async () => {
    const fixture = mysqlDrizzle();
    const source = createDrizzleDataSource(fixture.db, 'user', { user: fixture.table }, operators);
    await expect(source.create({ name: 'missing' })).rejects.toThrow(/cannot learn the new key/);
    expect(fixture.native.stores.user!.records.size).toBe(0);
    Object.assign(fixture.table.id!, { primary: true, autoIncrement: true });
    expect(await source.create({ name: 'generated' })).toEqual({ id: '1', name: 'generated' });
    fixture.emptyIds = true;
    await expect(source.create({ name: 'empty' })).rejects.toThrow(/no generated key/);
    const boom = new Error('pool acquisition failed');
    fixture.connectionError = boom;
    await expect(source.update('1', { name: 'never' })).rejects.toBe(boom);
  });
  it('runs proxy read-backs unwrapped and refuses a generated-key create', async () => {
    const fixture = mysqlDrizzle();
    const source = createDrizzleDataSource(
      fixture.db,
      'user',
      { user: fixture.table },
      { ...operators, mysqlProxy: true },
    );
    await source.create({ id: 'a', name: 'old' });
    await source.update('a', { name: 'new' });
    expect(fixture.transactions).toBe(0);
    Object.assign(fixture.table.id!, { primary: true, autoIncrement: true });
    await expect(source.create({ name: 'unknown' })).rejects.toThrow(/cannot learn/);
  });
});

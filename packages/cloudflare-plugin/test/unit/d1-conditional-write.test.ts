import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildDeleteWhere,
  buildUpdateWhere,
  D1_MAX_BOUND_PARAMS,
} from '../../src/database/d1-sql.ts';
import {
  createD1DataSource,
  createD1TransactionDataSource,
  D1TransactionBuffer,
} from '../../src/database/d1-data-source.ts';
import { SqliteD1 } from '../d1-fakes.ts';
const target = { table: 'users', primaryKey: ['id'] };
describe('D1 conditional writes', () => {
  it('conjoins key and predicate with separately bound values', () => {
    expect(buildUpdateWhere(target, 'a', { id: 'b', role: 'owner' }, { name: 'new' })).toEqual({
      sql:
        'UPDATE "users" SET "name" = ?1 WHERE "id" = ?2 AND "id" = ?3 AND "role" = ?4 RETURNING *',
      params: ['new', 'a', 'b', 'owner'],
    });
    expect(buildDeleteWhere(target, 'a', { role: 'owner' })).toEqual({
      sql: 'DELETE FROM "users" WHERE "id" = ?1 AND "role" = ?2 RETURNING "id"',
      params: ['a', 'owner'],
    });
  });
  it('refuses the combined parameter budget and omits transaction members', async () => {
    const where = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMS }, (_, i) => [`f${i}`, i]),
    );
    expect(() => buildDeleteWhere(target, 'a', where)).toThrow(/parameter/);
    expect(() => buildUpdateWhere(target, 'a', where, { name: 'new' })).toThrow(/parameter/);
    const db = new SqliteD1('CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT, role TEXT)');
    const tx = createD1TransactionDataSource(db, target, new D1TransactionBuffer());
    expect(tx.updateWhere).toBeUndefined();
    expect(tx.deleteWhere).toBeUndefined();
    const source = createD1DataSource(db, target);
    await source.create({ id: 'a', role: 'owner', name: 'old' });
    expect(await source.updateWhere!('a', { role: 'other' }, { name: 'bad' })).toBeNull();
    expect(await source.updateWhere!('missing', { role: 'owner' }, { name: 'bad' })).toBeNull();
    expect(await source.deleteWhere!('missing', { role: 'owner' })).toBe(false);
    expect(await source.deleteWhere!('a', { role: 'other' })).toBe(false);
    expect(await source.updateWhere!('a', { role: 'owner' }, { name: 'new' })).toMatchObject({
      name: 'new',
    });
    expect(await source.findById('a')).toMatchObject({ name: 'new' });
    expect(await source.deleteWhere!('a', { role: 'owner', name: 'new' })).toBe(true);
    expect(await source.findById('a')).toBeNull();
  });
});

describe('D1 conditional-write refusals name no caller field (M105 audit O3)', () => {
  it('refuses a non-identifier precondition field without echoing it', async () => {
    const source = createD1DataSource(
      new SqliteD1('CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT, role TEXT)'),
      target,
    );
    for (
      const attempt of [
        () => source.updateWhere!('a', { 'canary field': 'v' }, { name: 'x' }),
        () => source.deleteWhere!('a', { 'canary field': 'v' }),
      ]
    ) {
      const error = await attempt().then(() => undefined, (caught: unknown) => caught);
      expect((error as Error).message).toMatch(/not a valid SQL identifier/);
      expect((error as Error).message).not.toContain('canary');
    }
  });
});

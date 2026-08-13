import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as database from '../../src/index.ts';

describe('database-plugin barrel exports', () => {
  it('exports the typed Drizzle seam without leaking internal symbols', () => {
    expect(typeof database.createDrizzleDatabase).toBe('function');
    expect(typeof database.getDrizzle).toBe('function');
    expect(Object.hasOwn(database, 'DRIZZLE_DATABASE')).toBe(false);
    expect(Object.hasOwn(database, 'DRIZZLE_QUERY_HANDLE')).toBe(false);
    expect(Object.hasOwn(database, 'DrizzleInstance')).toBe(false);
  });

  it('retains the established runtime exports', () => {
    for (
      const name of [
        'DatabasePlugin',
        'DatabaseService',
        'BaseRepository',
        'UnitOfWork',
        'MemoryAdapter',
        'PrismaAdapter',
        'PrismaRepository',
        'createPrismaDataSource',
        'DrizzleAdapter',
        'DrizzleRepository',
        'createDrizzleDataSource',
      ]
    ) {
      expect(Object.hasOwn(database, name)).toBe(true);
    }
  });
});

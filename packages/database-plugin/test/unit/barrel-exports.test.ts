import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as database from '../../src/index.ts';
import type {
  DrizzleAdapterOptions,
  DrizzleDatabaseOptions,
  MemoryDatabaseOptions,
  PrismaAdapterOptions,
  PrismaDatabaseOptions,
} from '../../src/index.ts';

describe('database-plugin barrel exports', () => {
  it('exports the typed Drizzle seam without leaking internal symbols', () => {
    expect(typeof database.createDrizzleDatabase).toBe('function');
    expect(typeof database.getDrizzleDatabase).toBe('function');
    expect(typeof database.getDrizzleTransaction).toBe('function');
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

  it('exports the per-adapter option arms M70j added', () => {
    // Type-only exports leave no runtime trace, so the assertion has to be a
    // compile-time one: these annotations fail `deno check` if the barrel
    // stops exporting a name. Dropping one otherwise leaves every other test
    // green, because they all import the concrete module (the M56 defect).
    const memory: MemoryDatabaseOptions = { type: 'memory' };
    const prismaOptions: PrismaAdapterOptions = { prismaClient: {} };
    const prisma: PrismaDatabaseOptions = { type: 'prisma', options: prismaOptions };
    const drizzleOptions = {
      drizzleInstance: null,
      drizzleTables: {},
    } as unknown as DrizzleAdapterOptions;
    const drizzle: DrizzleDatabaseOptions = { type: 'drizzle', options: drizzleOptions };
    expect([memory.type, prisma.type, drizzle.type]).toEqual(['memory', 'prisma', 'drizzle']);
  });

  it('does not leak the internal raw-statement binder', () => {
    // `bindRawStatement` is a package-internal seam; exporting it would make
    // Drizzle's chunk protocol part of this package's published contract.
    expect(Object.hasOwn(database, 'bindRawStatement')).toBe(false);
    expect(Object.hasOwn(database, 'unknownColumnError')).toBe(false);
    expect(Object.hasOwn(database, 'observedColumns')).toBe(false);
  });
});

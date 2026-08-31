import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as database from '../../src/index.ts';
import type {
  CursorValue,
  DrizzleAdapterOptions,
  DrizzleDatabaseOptions,
  MemoryDatabaseOptions,
  MongoAdapterOptions,
  MongoDatabaseOptions,
  MongoEntityMapping,
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
    const mongoOptions: MongoAdapterOptions = {
      url: 'mongodb://localhost:27017/app',
    };
    const mongo: MongoDatabaseOptions = { type: 'mongodb', options: mongoOptions };
    const mapping: MongoEntityMapping = { collection: 'users', primaryKey: 'user_id' };
    expect([memory.type, prisma.type, drizzle.type, mongo.type, mapping.collection]).toEqual([
      'memory',
      'prisma',
      'drizzle',
      'mongodb',
      'users',
    ]);
  });

  it('re-exports CursorValue from the application-facing data-access contract', () => {
    const cursorValue: CursorValue = new Date('2026-08-31T00:00:00.000Z');
    expect(cursorValue).toBeInstanceOf(Date);
  });

  it('exports the Mongo adapter and only its application-facing surface', () => {
    expect(typeof database.MongoAdapter).toBe('function');
    expect(typeof database.UnsupportedRawQueryError).toBe('function');
    expect(typeof database.MongoTransactionUnavailableError).toBe('function');
    for (
      const internal of [
        'createMongoDataSource',
        'MongoTransaction',
        'createInjectedClientLoader',
        'createLazyClientLoader',
        'translateQuery',
        'resolveMongoTarget',
        'parseDatabaseFromUrl',
      ]
    ) {
      expect(Object.hasOwn(database, internal)).toBe(false);
    }
  });

  it('does not leak the internal raw-statement binder', () => {
    // `bindRawStatement` is a package-internal seam; exporting it would make
    // Drizzle's chunk protocol part of this package's published contract.
    expect(Object.hasOwn(database, 'bindRawStatement')).toBe(false);
    expect(Object.hasOwn(database, 'unknownColumnError')).toBe(false);
    expect(Object.hasOwn(database, 'observedColumns')).toBe(false);
  });
});

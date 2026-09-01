import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as common from '@setu-ts/common';
import * as database from '../../src/index.ts';
import type {
  CursorValue,
  DrizzleAdapterOptions,
  DrizzleDatabaseOptions,
  DynamoAdapterOptions,
  DynamoDatabaseOptions,
  DynamoEntityMapping,
  DynamoSdkModule,
  IDynamoClient,
  MemoryDatabaseOptions,
  MongoAdapterOptions,
  MongoDatabaseOptions,
  MongoEntityMapping,
  PrismaAdapterOptions,
  PrismaDatabaseOptions,
  SqlJsonDialect,
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

  it('re-exports SqlJsonDialect, which types a published option', () => {
    // `DrizzleAdapterOptions.dialect` is typed by this union, so without the
    // re-export the option's own type is unnameable by a consumer — the defect
    // M52c found on `NormalizedQuery` reaching a published `DataSource`
    // signature. Pinned at COMPILE time rather than by a runtime assertion: a
    // type export leaves no runtime trace, so dropping it would keep every
    // other assertion in this file green (the M56 defect class).
    const dialects: readonly SqlJsonDialect[] = ['postgresql', 'mysql', 'sqlite'];
    const configured: DrizzleAdapterOptions['dialect'] = dialects[0];
    expect(configured).toBe('postgresql');
    // The whole union is assignable to the option, so the two cannot drift.
    for (const dialect of dialects) {
      const arm: DrizzleAdapterOptions['dialect'] = dialect;
      expect(typeof arm).toBe('string');
    }
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

  it('exports the DynamoDB adapter and only its application-facing surface (M80 plan §4)', () => {
    expect(typeof database.DynamoAdapter).toBe('function');
    expect(typeof database.createInjectedDynamoLoader).toBe('function');
    expect(typeof database.createLazyDynamoLoader).toBe('function');
    for (
      const internal of [
        'DynamoTarget',
        'resolveDynamoTarget',
        'createDynamoDataSource',
        'createDynamoTransactionBuffer',
        'IDynamoTransactionBuffer',
        'resolveDynamoAccessPath',
        'translateDynamoFilter',
        'createDynamoExpressionBuilder',
        'marshalDynamoValue',
        'unmarshalDynamoItem',
        'adaptDynamoSdkModule',
      ]
    ) {
      expect(Object.hasOwn(database, internal)).toBe(false);
    }
  });

  it('exports the DynamoDB option and seam types (compile-time pin)', () => {
    // Type-only exports leave no runtime trace, so the pin is the annotation:
    // these fail `deno check` if the barrel stops exporting a name (the M56
    // defect class). Both `DynamoAdapterOptions` arms type-check on their own.
    const lazy: DynamoAdapterOptions = { region: 'us-east-1' };
    const injected: DynamoAdapterOptions = { client: {} as never };
    const arm: DynamoDatabaseOptions = { type: 'dynamodb', options: lazy };
    const mapping: DynamoEntityMapping = { partitionKey: 'id', sortKey: 'sk' };
    const client: IDynamoClient = {
      query: () => Promise.resolve({}),
      scan: () => Promise.resolve({}),
      getItem: () => Promise.resolve({}),
      putItem: () => Promise.resolve({}),
      updateItem: () => Promise.resolve({}),
      deleteItem: () => Promise.resolve({}),
      transactWriteItems: () => Promise.resolve({}),
      destroy() {},
    };
    // The module shape the lazy loader adapts — the type the guarded
    // real-import test annotates against.
    const sdkModule: DynamoSdkModule = {} as never;
    void sdkModule;
    expect([arm.type, lazy.region, injected.client !== undefined, mapping.partitionKey]).toEqual([
      'dynamodb',
      'us-east-1',
      true,
      'id',
    ]);
    expect(typeof client.query).toBe('function');
  });

  it('leaves the common barrel unchanged — M80 adds nothing there (M80 plan §4)', () => {
    // The M80 plan commits `common` to ZERO new symbols: M79 already shipped
    // every contract member the DynamoDB backend consumes. Pinning the absence
    // by name catches a Dynamo export landing in the wrong package — every
    // other assertion here imports the concrete module and would stay green.
    for (
      const name of [
        'DynamoAdapter',
        'DynamoDatabaseOptions',
        'DynamoAdapterOptions',
        'DynamoEntityMapping',
        'IDynamoClient',
        'DynamoSdkModule',
        'createInjectedDynamoLoader',
        'createLazyDynamoLoader',
      ]
    ) {
      expect(Object.hasOwn(common, name)).toBe(false);
    }
  });
});

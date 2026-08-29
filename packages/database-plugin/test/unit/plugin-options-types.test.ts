/**
 * D7 — the adapter-specific options a built-in arm cannot run without are
 * required by the union, so omitting one is a compile error rather than a
 * `connect()` throw.
 *
 * These assertions are compile-only: `@ts-expect-error` fails the build when
 * the configuration below starts type-checking again, which is the whole
 * guarantee. The runtime guards behind them are asserted separately, in each
 * adapter's own suite, because a JavaScript caller still reaches them.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import type { BuiltInDatabaseOptions, DatabasePluginOptions } from '../../src/interfaces/index.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

/** Never invoked; every assertion here is made by the type-checker. */
function assertOptionArms(): void {
  // --- accepted -----------------------------------------------------------
  DatabasePlugin();
  DatabasePlugin({});
  DatabasePlugin({ type: 'memory' });
  DatabasePlugin({ type: 'memory', name: 'scratch', options: { logQueries: true } });
  DatabasePlugin({ type: 'prisma', options: { prismaClient: {} } });
  DatabasePlugin({
    type: 'prisma',
    options: { prismaClient: {}, provider: 'postgresql', transactionTimeout: 60_000 },
  });
  DatabasePlugin({
    type: 'drizzle',
    options: {
      drizzleInstance: createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (database, work) => database.transaction(work),
      ),
      drizzleTables: { user: createFakeDrizzleTable('user') },
    },
  });

  // --- refused ------------------------------------------------------------
  // @ts-expect-error the Prisma arm requires `options`.
  DatabasePlugin({ type: 'prisma' });
  // @ts-expect-error the Prisma arm requires `options.prismaClient`.
  DatabasePlugin({ type: 'prisma', options: { logQueries: true } });
  // @ts-expect-error the Drizzle arm requires `options`.
  DatabasePlugin({ type: 'drizzle' });
  DatabasePlugin({
    type: 'drizzle',
    // @ts-expect-error the Drizzle arm requires `options.drizzleInstance`.
    options: { drizzleTables: { user: createFakeDrizzleTable('user') } },
  });
  DatabasePlugin({
    type: 'drizzle',
    // @ts-expect-error the Drizzle arm requires `options.drizzleTables`.
    options: {
      drizzleInstance: createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (database, work) => database.transaction(work),
      ),
    },
  });
  // @ts-expect-error the memory arm does not accept another adapter's discriminant.
  DatabasePlugin({ type: 'sqlite' });

  // `BuiltInDatabaseOptions` keeps its published name and still accepts a
  // memory configuration, so an existing annotation compiles unchanged.
  const memory: BuiltInDatabaseOptions = { name: 'scratch' };
  const plugin: DatabasePluginOptions = memory;
  void plugin;

  // --- the mongodb arm ----------------------------------------------------
  // Either half of the union satisfies it on its own.
  const mongoLazy: DatabasePluginOptions = {
    type: 'mongodb',
    options: { url: 'mongodb://127.0.0.1:27017/app' },
  };
  void mongoLazy;
  const mongoInjected: DatabasePluginOptions = {
    type: 'mongodb',
    options: { client: {} as never, database: 'app' },
  };
  void mongoInjected;

  // `logQueries` is read by the SERVICE for every arm and carried by
  // `buildAdapterOptions`, so the Mongo arm must be able to express it. It was
  // the only built-in arm that could not: the options type did not inherit the
  // shared bag, so this literal failed excess-property checking (TS2353) while
  // the feature worked at runtime.
  const mongoLogged: DatabasePluginOptions = {
    type: 'mongodb',
    options: { url: 'mongodb://127.0.0.1:27017/app', logQueries: true },
  };
  void mongoLogged;

  // --- rejected -----------------------------------------------------------
  const mongoNeither: DatabasePluginOptions = {
    type: 'mongodb',
    // @ts-expect-error -- neither `url` nor `client`: no arm of the union matches.
    options: { database: 'app' },
  };
  void mongoNeither;
}
void assertOptionArms;

describe('DatabasePlugin option arms', () => {
  it('registers a fully specified drizzle configuration', () => {
    const plugin = DatabasePlugin({
      type: 'drizzle',
      options: {
        drizzleInstance: createDrizzleDatabase(
          createFakeDrizzleInstance(),
          (database, work) => database.transaction(work),
        ),
        drizzleTables: { user: createFakeDrizzleTable('user') },
      },
    });
    expect(plugin.name).toBe('database-plugin');
  });

  it('still defaults to the memory arm when no type is given', () => {
    expect(DatabasePlugin().name).toBe('database-plugin');
  });
});

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assertType } from '@std/testing/types';
import type { IsExact } from '@std/testing/types';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { eq } from 'npm:drizzle-orm@0.45.2';
import { drizzle } from 'npm:drizzle-orm@0.45.2/sqlite-proxy';
import { sqliteTable, text } from 'npm:drizzle-orm@0.45.2/sqlite-core';
import type { BetterSQLite3Database } from 'npm:drizzle-orm@0.45.2/better-sqlite3';
import {
  createDrizzleDatabase,
  DrizzleAdapter,
  type DrizzleDatabase,
  type DrizzleTransaction,
  getDrizzle,
} from '../../src/index.ts';
import type { IDatabaseService, IUnitOfWork } from '../../src/interfaces/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';

const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  teamId: text('team_id').notNull(),
});

interface User {
  id: string;
  name: string;
  teamId: string;
}

interface JoinedUserTeam {
  userId: string;
  userName: string;
  teamName: string;
}

type ForgedDatabase<TDatabase extends object> = Omit<TDatabase, 'transaction'> & {
  transaction<T>(callback: (transaction: TDatabase) => Promise<T>): Promise<T>;
};

declare const synchronousDatabase: BetterSQLite3Database;

/** Compile-only assertions for the two public overloads; this function is never invoked. */
function assertDrizzleScopeTypes(
  drizzleDb: ReturnType<typeof drizzle>,
  database: DrizzleDatabase<ReturnType<typeof drizzle>>,
  service: IDatabaseService,
  uow: IUnitOfWork,
): void {
  const outer = getDrizzle(service, database);
  outer.batch;
  assertType<IsExact<typeof outer, typeof drizzleDb>>(true);

  const transaction = getDrizzle(uow, database);
  assertType<IsExact<typeof transaction, DrizzleTransaction<typeof drizzleDb>>>(true);
  // @ts-expect-error SQLite Proxy transactions exclude the outer database's batch operation.
  transaction.batch;

  // @ts-expect-error The configured witness cannot be reused with a forged database generic.
  getDrizzle<ForgedDatabase<typeof drizzleDb>>(uow, database).batch;

  // @ts-expect-error Synchronous callback drivers cannot create a supported witness.
  createDrizzleDatabase(synchronousDatabase);
}
void assertDrizzleScopeTypes;

interface ArrayReturningStatement {
  run(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[][];
  setReturnArrays(enabled: boolean): void;
}

function executeSqlite(
  engine: DatabaseSync,
  statement: string,
  params: readonly SQLInputValue[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<{ rows: unknown[] }> {
  // Deno's node:sqlite runtime exposes setReturnArrays(), but its Node type
  // snapshot does not yet declare the method.
  const prepared = engine.prepare(statement) as unknown as ArrayReturningStatement;
  if (method === 'run') {
    prepared.run(...params);
    return Promise.resolve({ rows: [] });
  }
  prepared.setReturnArrays(true);
  const rows = prepared.all(...params);
  return Promise.resolve({ rows });
}

describe('typed Drizzle query seam on real SQLite', () => {
  it('shares uncommitted repository writes with a typed join and rolls both back', async () => {
    const engine = new DatabaseSync(':memory:');
    engine.exec('CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    engine.exec(
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, team_id TEXT NOT NULL)',
    );
    engine.exec("INSERT INTO teams VALUES ('t1', 'Research')");

    const drizzleDb = drizzle((statement, params, method) =>
      executeSqlite(engine, statement, params, method)
    );
    const database = createDrizzleDatabase(drizzleDb);
    const adapter = new DrizzleAdapter({
      drizzleInstance: database,
      drizzleTables: { User: users, Team: teams },
    });
    await adapter.connect();
    const service = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'drizzle',
    );

    const sentinel = new Error('rollback typed join');
    await expect(
      service.transaction(async (uow) => {
        await uow.getRepository<User>('User').create({
          id: 'u1',
          name: 'Ada',
          teamId: 't1',
        });

        const tx = getDrizzle(uow, database);
        expect(tx).not.toBe(drizzleDb);
        const joined = await tx
          .select({
            userId: users.id,
            userName: users.name,
            teamName: teams.name,
          })
          .from(users)
          .innerJoin(teams, eq(users.teamId, teams.id));
        assertType<IsExact<typeof joined, JoinedUserTeam[]>>(true);
        expect(joined).toEqual([{ userId: 'u1', userName: 'Ada', teamName: 'Research' }]);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    const outer = getDrizzle(service, database);
    expect(outer).toBe(drizzleDb);
    expect(await outer.select().from(users)).toEqual([]);
    expect(await service.getRepository<User>('User').findById('u1')).toBeNull();
  });
});

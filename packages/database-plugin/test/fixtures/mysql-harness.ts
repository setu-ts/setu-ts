import { readFile } from 'node:fs/promises';
import { createConnection, createPool } from 'mysql2/promise';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { drizzle } from 'drizzle-orm/mysql2';
import type { IDatabaseAdapter } from '@setu-ts/common';
import {
  createDrizzleDatabase,
  DatabaseService,
  DrizzleAdapter,
  PrismaAdapter,
} from '../../src/index.ts';
import { mysqlTables } from './mysql-tables.ts';
import { cleanupAfter, cleanupAll } from './cleanup-all.ts';

/**
 * Each harness owns an explicitly-created database; no existing table is adopted or dropped.
 * `prismaClient` names the generated client folder beside this file the Prisma arm loads.
 */
export async function mysqlHarness(
  type: 'prisma' | 'drizzle',
  connections = 110,
  prismaClient = 'prisma-client-generated-mysql',
) {
  const endpoint = new URL(process.env['MYSQL_URL']!);
  const name = `setu_mysql_${crypto.randomUUID().replaceAll('-', '')}`;
  const options = {
    host: endpoint.hostname,
    port: Number(endpoint.port || 3306),
    user: decodeURIComponent(endpoint.username),
    password: decodeURIComponent(endpoint.password),
  };
  const admin = await createConnection(options);
  // Every resource is owned from the moment it exists: the steps run newest
  // first, each attempted even if an earlier one fails, and the database is
  // dropped only once CREATE DATABASE has succeeded.
  const owned: (() => unknown)[] = [() => admin.end()];
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);
  } catch (error) {
    return await cleanupAfter(error, owned);
  }
  owned.unshift(() => admin.query(`DROP DATABASE \`${name}\``));
  const pool = createPool({ ...options, database: name, connectionLimit: connections });
  owned.unshift(() => pool.end());
  let adapter: IDatabaseAdapter | undefined;
  try {
    for (const fixture of [
      'outbox',
      'inbox',
      'idempotency',
      'tenant-store',
      'grant-source',
      'agent-runs',
      'mysql-rows',
    ]) {
      const ddl = await readFile(new URL(`./${fixture}-mysql.sql`, import.meta.url), 'utf8');
      for (const statement of ddl.split(';').filter((sql) => sql.trim()))
        await pool.query(statement);
    }
    if (type === 'drizzle') {
      adapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
        drizzleTables: mysqlTables,
        dialect: 'mysql',
        entities: { Compound: { primaryKey: ['tenantId', 'id'] } },
      });
    } else {
      const generated = new URL(`./${prismaClient}/client.ts`, import.meta.url).href;
      const { PrismaClient } = await import(generated);
      const client: unknown = new PrismaClient({
        adapter: new PrismaMariaDb({
          ...options,
          database: name,
          connectionLimit: connections,
          allowPublicKeyRetrieval: true,
        }),
      });
      adapter = new PrismaAdapter({
        prismaClient: client,
        provider: 'mysql',
        entities: { Compound: { keyColumns: ['tenantId', 'id'], compositeKeyName: 'tenantId_id' } },
      });
    }
    const built = adapter;
    owned.unshift(() => built.disconnect());
    await adapter.connect();
    const connected = adapter;
    const database = new DatabaseService(
      connected,
      (entity) => connected.createDataSource(entity),
      type,
    );
    return {
      name,
      pool,
      adapter: connected,
      database,
      // The service's close disconnects the adapter, so it replaces that step.
      dispose: () => cleanupAll([() => database.close(), ...owned.slice(1)]),
    };
  } catch (error) {
    return await cleanupAfter(error, owned);
  }
}

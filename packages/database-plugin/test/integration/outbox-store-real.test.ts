/**
 * The outbox store bridge against real backends (M107 §3.4).
 *
 * - **PostgreSQL** (`OUTBOX_POSTGRES_URL`, Drizzle over `npm:pg`): the
 *   committed DDL fixture is applied to a throwaway schema, the `IOutboxStore`
 *   contract runs against it, a business row and an outbox row commit or roll
 *   back together, and `verify()` refuses a schema without the table.
 * - **MongoDB standalone** (`MONGODB_URI` — a standalone `mongo:8` in CI):
 *   `verify()` refuses with the REPLICA-SET reason specifically. The variable
 *   must name a standalone server; against a replica set this test fails, which
 *   is the signal that it does not.
 *
 * Both guard with `ignore:` on their variable — never an early return.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/node-postgres';
import { bigint, integer, pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { Pool } from 'npm:pg@^8.0.0';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';
import {
  createDrizzleDatabase,
  DatabaseService,
  OutboxStoreUnavailableError,
} from '../../src/index.ts';
import type { IDatabaseService } from '../../src/interfaces/index.ts';
import { DatabaseOutboxStore } from '../../src/outbox/database-outbox-store.ts';
import { describeOutboxStoreContract } from '../fixtures/outbox-store-contract.ts';
import type { OutboxStoreUnderTest } from '../fixtures/outbox-store-contract.ts';
import { record } from '../fixtures/outbox-store.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const skipPostgres = postgresUrl === undefined;
const mongoUrl = Deno.env.get('MONGODB_URI');
const skipMongo = mongoUrl === undefined;

/** The Drizzle table over the committed DDL fixture's columns. */
const outbox = pgTable('setu_outbox', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  topic: text('topic').notNull(),
  envelope: text('envelope').notNull(),
  options: text('options').notNull(),
  orderingKey: text('ordering_key'),
  tenantId: text('tenant_id'),
  traceparent: text('traceparent'),
  position: text('position').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  availableAt: bigint('available_at', { mode: 'number' }).notNull(),
  lastError: text('last_error'),
  settledAt: bigint('settled_at', { mode: 'number' }),
  sentBy: text('sent_by'),
});

/** A business table sharing the outbox's transaction. */
const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  total: integer('total').notNull(),
});

/** A Drizzle-backed service over a fresh schema, with or without the outbox table. */
interface PostgresHarness {
  readonly service: IDatabaseService;
  readonly dispose: () => Promise<void>;
}

/** Creates a throwaway schema, optionally applies the DDL fixture, and connects. */
async function postgres(withTable: boolean): Promise<PostgresHarness> {
  const schema = `m107_outbox_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: postgresUrl!, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({
    connectionString: postgresUrl!,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  if (withTable) {
    await pool.query(
      await Deno.readTextFile(new URL('../fixtures/outbox-postgres.sql', import.meta.url)),
    );
    await pool.query('CREATE TABLE orders (id text PRIMARY KEY, total integer NOT NULL)');
  }
  const adapter = new DrizzleAdapter({
    drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
    drizzleTables: { Outbox: outbox, Order: orders },
  });
  await adapter.connect();
  const service = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'drizzle');
  return {
    service,
    dispose: async () => {
      await adapter.disconnect();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

describeOutboxStoreContract('database bridge over real PostgreSQL (Drizzle)', async (): Promise<
  OutboxStoreUnderTest
> => {
  const { service, dispose } = await postgres(true);
  return {
    store: new DatabaseOutboxStore(service, 'Outbox'),
    inTransaction: (work) => service.transaction((uow) => work(uow)),
    dispose,
  };
}, skipPostgres);

describe('DatabaseOutboxStore over real PostgreSQL', { ignore: skipPostgres }, () => {
  it('writes kind and NULL optionals into the DDL columns', async () => {
    const { service, dispose } = await postgres(true);
    try {
      const store = new DatabaseOutboxStore(service, 'Outbox');
      await service.transaction((uow) => store.append(uow, record(1)));
      const rows = await service.query<Record<string, unknown>>(
        'SELECT kind, tenant_id, settled_at, created_at FROM setu_outbox',
      );
      expect(rows).toEqual([
        { kind: OUTBOX_RECORD_KIND, tenant_id: null, settled_at: null, created_at: '1001' },
      ]);
      expect(await store.scanPending(undefined, 10)).toEqual([record(1)]);
    } finally {
      await dispose();
    }
  });

  it('commits the business row and the outbox row together, and rolls both back', async () => {
    const { service, dispose } = await postgres(true);
    try {
      const store = new DatabaseOutboxStore(service, 'Outbox');
      await service.transaction(async (uow) => {
        await uow.getRepository('Order').create({ id: 'o1', total: 10 });
        await store.append(uow, record(1));
      });
      const failed = await service.transaction(async (uow) => {
        await uow.getRepository('Order').create({ id: 'o2', total: 20 });
        await store.append(uow, record(2));
        throw new Error('business rule');
      }).catch((e: unknown) => e);

      expect((failed as Error).message).toBe('business rule');
      expect((await service.getRepository<{ id: string }>('Order').findAll()).map((r) => r.id))
        .toEqual(['o1']);
      expect((await store.scanPending(undefined, 10)).map((r) => r.id)).toEqual(['row-1']);
    } finally {
      await dispose();
    }
  });

  it('verify passes with the table and refuses a schema without it', async () => {
    const ready = await postgres(true);
    const missing = await postgres(false);
    try {
      await new DatabaseOutboxStore(ready.service, 'Outbox').verify();
      const refusal = await new DatabaseOutboxStore(missing.service, 'Outbox').verify().catch((
        e: unknown,
      ) => e);
      expect(refusal).toBeInstanceOf(OutboxStoreUnavailableError);
      expect((refusal as OutboxStoreUnavailableError).reason).toBe('entity-unavailable');
      expect((refusal as Error).cause).toBeInstanceOf(Error);
    } finally {
      await ready.dispose();
      await missing.dispose();
    }
  });
});

describe('DatabaseOutboxStore over a standalone MongoDB', { ignore: skipMongo }, () => {
  it('verify refuses with the replica-set reason specifically', async () => {
    const adapter = new MongoAdapter({
      url: mongoUrl!,
      database: 'setu_m107_outbox',
      collections: { Outbox: { collection: `outbox_${crypto.randomUUID()}` } },
    });
    await adapter.connect();
    try {
      const service = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'mongodb');
      const refusal = await new DatabaseOutboxStore(service, 'Outbox').verify().catch((
        e: unknown,
      ) => e);

      expect(refusal).toBeInstanceOf(OutboxStoreUnavailableError);
      expect((refusal as OutboxStoreUnavailableError).reason).toBe('mongodb-replica-set');
      // The driver's own refusal, measured unwrapped: code 20, IllegalOperation.
      expect((refusal as Error).cause).toMatchObject({ code: 20, codeName: 'IllegalOperation' });
    } finally {
      await adapter.disconnect();
    }
  });
});

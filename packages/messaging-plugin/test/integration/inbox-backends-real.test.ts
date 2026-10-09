/**
 * The inbox store bridge against REAL backends (M108 §3.6, §3.10, §6).
 *
 * - **PostgreSQL** (`OUTBOX_POSTGRES_URL`): two "processes" run the same
 *   marker concurrently. The second insert blocks on the primary key until the
 *   first transaction commits, then fails — so exactly one handler commits,
 *   the loser rejects, and a re-read finds the marker.
 * - **MongoDB replica set** (`MONGODB_RS_URI`): the same race. The loser
 *   rejects with a write CONFLICT, not a duplicate — the reason the delivery
 *   path re-reads after any rejection rather than only after a
 *   `DuplicateKeyError`.
 * - **Bigtable emulator** (`BIGTABLE_EMULATOR_ENDPOINT`): `start()` refuses
 *   with the `bigtable-unsupported` reason.
 * - **Standalone MongoDB** (`MONGODB_URI`, the CI service): `start()` refuses
 *   with the `mongodb-standalone` reason, through the transactional probe.
 *
 * Every case guards with `ignore:` on its variable — never an early return.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseAdapter, IInboxStore, InboxRecord } from '@setu-ts/common';
import { CAPABILITIES, INBOX_RECORD_KIND } from '@setu-ts/common';
import {
  BigtableAdapter,
  createDatabaseInboxStore,
  DatabasePlugin,
  InboxStoreUnavailableError,
  MongoAdapter,
} from '@setu-ts/database-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import {
  drizzleInboxAdapter,
  postgresInboxSchema,
} from '../../../database-plugin/test/fixtures/inbox-postgres.ts';

import { MessagingPlugin } from '../../src/index.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const mongoRsUri = Deno.env.get('MONGODB_RS_URI');
const mongoStandaloneUri = Deno.env.get('MONGODB_URI');
const bigtableEndpoint = Deno.env.get('BIGTABLE_EMULATOR_ENDPOINT');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** A database-only app over one adapter. */
function databaseApp(adapter: IDatabaseAdapter): IKernelApplication {
  return createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
  });
}

/** The marker both processes race for. */
const marker: InboxRecord = {
  id: 'c'.repeat(64),
  kind: INBOX_RECORD_KIND,
  consumer: 'payroll',
  topic: 'people.hired.v1',
  status: 'processed',
  attempts: 0,
  updatedAt: 1,
};

/**
 * Races two `run`s for one marker: A holds its transaction open until B has
 * started, then commits. Returns how each settled.
 */
async function race(a: IInboxStore, b: IInboxStore): Promise<PromiseSettledResult<string>[]> {
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  let aInside!: () => void;
  const aStarted = new Promise<void>((resolve) => (aInside = resolve));
  const write = (store: IInboxStore, name: string, gate?: Promise<void>) =>
    store.run(marker, async (scope) => {
      aInside();
      await (scope as IUnitOfWork).getRepository<Record<string, unknown>>('Person')
        .create({ id: `p-${name}`, name });
      if (gate !== undefined) await gate;
      return name;
    });
  const first = write(a, 'a', gateA);
  await aStarted;
  const second = write(b, 'b');
  // Observed at once: on MongoDB the loser rejects while A is still open.
  const settled = Promise.allSettled([first, second]);
  // Give B time to reach (and, on PostgreSQL, block on) its insert.
  await new Promise((r) => setTimeout(r, 200));
  releaseA();
  return await settled;
}

describe('inbox over real PostgreSQL', { ignore: postgresUrl === undefined }, () => {
  it('two concurrent runs for one marker: one commits, the loser rejects, the marker is there', async () => {
    const pg = await postgresInboxSchema(postgresUrl!);
    const first = databaseApp(drizzleInboxAdapter(pg.pool));
    const second = databaseApp(drizzleInboxAdapter(pg.pool));
    await first.start();
    await second.start();
    try {
      const a = createDatabaseInboxStore()(first.services);
      const b = createDatabaseInboxStore()(second.services);
      await a.verify();
      const [ra, rb] = await race(a, b);
      expect(ra).toEqual({ status: 'fulfilled', value: 'a' });
      expect(rb.status).toBe('rejected');
      expect((await b.find(marker.id))?.status).toBe('processed');
      const people = await pg.pool.query('SELECT id FROM people ORDER BY id');
      expect(people.rows).toEqual([{ id: 'p-a' }]);
      // verify() left no probe row behind.
      const inbox = await pg.pool.query('SELECT id FROM setu_inbox');
      expect(inbox.rows).toEqual([{ id: marker.id }]);
    } finally {
      await first.stop();
      await second.stop();
      await pg.dispose();
    }
  });
});

describe('inbox over a real MongoDB replica set', { ignore: mongoRsUri === undefined }, () => {
  it('the concurrent loser rejects (a write conflict), and the marker commits', async () => {
    const adapter = () =>
      new MongoAdapter({
        url: mongoRsUri!,
        database: 'setu_m108_inbox',
        collections: {
          Inbox: { collection: `inbox_${suffix}`, idType: 'raw' },
          Person: { collection: `people_${suffix}`, idType: 'raw' },
        },
      });
    const first = databaseApp(adapter());
    const second = databaseApp(adapter());
    await first.start();
    await second.start();
    try {
      // MongoDB refuses two transactions that each create the same collection
      // implicitly ("Collection namespace … is already in use"), so the
      // collections exist before the race — as the README tells an operator.
      const db = first.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      for (const entity of ['Inbox', 'Person']) {
        const repo = db.getRepository<Record<string, unknown>>(entity);
        await repo.create({ id: 'seed', kind: 'seed' });
        await repo.delete('seed');
      }
      const a = createDatabaseInboxStore()(first.services);
      const b = createDatabaseInboxStore()(second.services);
      await a.verify();
      const [ra, rb] = await race(a, b);
      expect(ra).toEqual({ status: 'fulfilled', value: 'a' });
      expect(rb.status).toBe('rejected');
      expect((await b.find(marker.id))?.status).toBe('processed');
    } finally {
      await first.stop();
      await second.stop();
      // The run's collections are unique to it; leave nothing behind.
      const { MongoClient } = await import('npm:mongodb@^6.21.0');
      const client = new MongoClient(mongoRsUri!);
      try {
        const db = client.db('setu_m108_inbox');
        for (const name of [`inbox_${suffix}`, `people_${suffix}`]) {
          await db.collection(name).drop().catch(() => false);
        }
      } finally {
        await client.close();
      }
    }
  });
});

/** The error `start()` rejected with. */
async function startFailure(app: IKernelApplication): Promise<unknown> {
  return await app.start().then(() => undefined, (error: unknown) => error);
}

/** An app with the inbox over one adapter. */
function inboxApp(adapter: IDatabaseAdapter): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      SchedulerPlugin(),
      DatabasePlugin({ type: 'custom', adapter }),
      MessagingPlugin({ inbox: { store: createDatabaseInboxStore() } }),
    ],
  });
}

describe('inbox refusals on real backends', () => {
  it('refuses Bigtable at start()', { ignore: bigtableEndpoint === undefined }, async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SchedulerPlugin(),
        // The shipped adapter through the `'custom'` arm — refused by class.
        DatabasePlugin({
          type: 'custom',
          adapter: new BigtableAdapter({
            projectId: 'setu-m108',
            instance: 'setu-m108-instance',
            apiEndpoint: bigtableEndpoint!,
          }),
        }),
        MessagingPlugin({ inbox: { store: createDatabaseInboxStore() } }),
      ],
    });
    const failure = await startFailure(app);
    await app.stop().catch(() => {});
    expect(failure).toBeInstanceOf(InboxStoreUnavailableError);
    expect((failure as InboxStoreUnavailableError).reason).toBe('bigtable-unsupported');
  });

  it(
    'refuses a standalone MongoDB at start()',
    { ignore: mongoStandaloneUri === undefined },
    async () => {
      const app = inboxApp(
        new MongoAdapter({
          url: mongoStandaloneUri!,
          database: 'setu_m108_inbox',
          collections: { Inbox: { collection: `inbox_${suffix}`, idType: 'raw' } },
        }),
      );
      const failure = await startFailure(app);
      await app.stop().catch(() => {});
      expect(failure).toBeInstanceOf(InboxStoreUnavailableError);
      expect((failure as InboxStoreUnavailableError).reason).toBe('mongodb-standalone');
    },
  );
});

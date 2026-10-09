/**
 * The inbox on Cloudflare D1 (M108 §3.10, §3.14), at unit level: the shipped
 * `D1Adapter` over a REAL SQLite engine (`cloudflare-plugin`'s `SqliteD1`
 * double — the engine D1 runs) with the committed SQLite/D1 DDL fixture, the
 * inbox with `purge: { schedule: false }` and NO scheduler, and a Cron
 * Trigger calling `inbox.purge()`.
 *
 * D1 defers every write in a transaction to ONE `batch()` at commit, so the
 * handler runs BEFORE a duplicate marker can be refused: the pre-read is what
 * keeps a sequential duplicate from running the handler at all. Not driven on
 * real workerd.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createScheduledHandler, D1Adapter, WorkersCron } from '@setu-ts/cloudflare-plugin';
import { createDatabaseInboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

import { MessagingPlugin, onIntegrationEvent } from '../../src/index.ts';
import type { IInbox } from '../../src/index.ts';
import { envelope, type Hired, hired } from '../fixtures/inbox.ts';

/** The committed SQLite/D1 DDL — the text the README embeds verbatim. */
const SQLITE_DDL = await Deno.readTextFile(
  new URL('../../../database-plugin/test/fixtures/inbox-sqlite.sql', import.meta.url),
);

const HOURLY = '0 * * * *';

/** Lets the in-memory broker deliver. */
function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('the inbox on D1', () => {
  it('records once, skips a duplicate, rolls back a failure, and purges from a Cron Trigger', async () => {
    const d1 = new SqliteD1(
      SQLITE_DDL,
      'CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    );
    const calls: string[] = [];
    let fail = false;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({
          type: 'custom',
          adapter: new D1Adapter(d1, {
            tables: { Inbox: { table: 'setu_inbox' }, Person: { table: 'people' } },
          }),
        }),
        MessagingPlugin({
          inbox: {
            store: createDatabaseInboxStore(),
            purge: { schedule: false },
            retainMs: 60_000,
          },
          subscriptions: [
            onIntegrationEvent(hired, async (payload: Hired, _e, _m, uow: IUnitOfWork) => {
              calls.push(payload.personId);
              await uow.getRepository<Record<string, unknown>>('Person')
                .create({ id: `${payload.personId}-${calls.length}`, name: 'Ada' });
              if (fail) throw new Error('handler failed');
            }, { inbox: { consumer: 'payroll' } }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await broker.publish(hired.topic, envelope('e-1'));
      await settle();
      await broker.publish(hired.topic, envelope('e-1'));
      await settle();
      expect(calls).toEqual(['p-1']);
      expect(d1.dump('people')).toHaveLength(1);
      expect(d1.dump('setu_inbox').map((row) => row.status)).toEqual(['processed']);

      fail = true;
      await broker.publish(hired.topic, envelope('e-2', { personId: 'p-2' }));
      await settle();
      expect(calls).toEqual(['p-1', 'p-2']);
      expect(d1.dump('people')).toHaveLength(1);
      expect(d1.dump('setu_inbox')).toHaveLength(1);

      // Age the processed marker past retention, then fire the Cron Trigger.
      const repo = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
        .getRepository<Record<string, unknown>>('Inbox');
      for (const row of d1.dump('setu_inbox')) {
        await repo.update(row.id as string, { updatedAt: 1 });
      }
      const inbox = app.services.get<IInbox>(CAPABILITIES.INBOX);
      const cron = new WorkersCron().on(HOURLY, async () => {
        await inbox.purge();
      });
      await createScheduledHandler(cron)({ cron: HOURLY, scheduledTime: 0 });
      expect(d1.dump('setu_inbox')).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});

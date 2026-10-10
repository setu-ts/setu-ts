/**
 * The Cloudflare Workers hybrid (M107 §3.12), at unit level: the shipped
 * `D1Adapter` over a REAL SQLite engine (`cloudflare-plugin`'s `SqliteD1`
 * double — the engine D1 runs) with the committed SQLite/D1 DDL fixture, the
 * outbox with `relay: { schedule: false }` and NO scheduler registered,
 * `background` standing in for the platform's `waitUntil`, and the shipped
 * `WorkersCron` + `createScheduledHandler` calling `outbox.sweep()` and
 * `outbox.purge()` the way a Cron Trigger does.
 *
 * Not driven on real workerd here: `apps/cloudflare` carries no D1 binding,
 * and adding one with its DDL is the remaining (unverified) half of §3.12.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createScheduledHandler, D1Adapter, WorkersCron } from '@setu-ts/cloudflare-plugin';
import {
  createDatabaseOutboxStore,
  DatabasePlugin,
  DatabaseService,
} from '@setu-ts/database-plugin';
import { MockServiceRegistry } from '@setu-ts/testing';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

import { MessagingPlugin } from '../../src/index.ts';
import type { IOutbox } from '../../src/index.ts';
import { FaultStore, orderPlaced } from '../fixtures/outbox.ts';
import { describeOutboxRelayProofs } from '../fixtures/outbox-relay-proofs.ts';

/** The committed SQLite/D1 DDL — the text the README embeds verbatim. */
const SQLITE_DDL = await Deno.readTextFile(
  new URL('../../../database-plugin/test/fixtures/outbox-sqlite.sql', import.meta.url),
);

const EVERY_MINUTE = '* * * * *';
const HOURLY = '0 * * * *';

describeOutboxRelayProofs('D1 over real SQLite', async () => {
  const adapter = new D1Adapter(new SqliteD1(SQLITE_DDL), {
    tables: { Outbox: { table: 'setu_outbox' } },
  });
  await adapter.connect();
  const db = new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'custom');
  const registry = new MockServiceRegistry();
  registry.register(CAPABILITIES.DATABASE, db);
  return {
    db,
    store: new FaultStore(createDatabaseOutboxStore()(registry)),
    dispose: () => db.close(),
  };
});

/** One Worker isolate's composition. */
interface WorkerHarness {
  readonly app: IKernelApplication;
  readonly d1: SqliteD1;
  readonly outbox: IOutbox;
  readonly db: IDatabaseService;
  /** Promises handed to `waitUntil`. */
  readonly waited: Promise<unknown>[];
  /** Envelope `data.n` values delivered to a subscriber. */
  readonly delivered: number[];
  /** Fires one Cron Trigger. */
  readonly fire: (cron: string) => Promise<void>;
}

/** Builds the Workers composition: D1 + outbox, no scheduler, cron-driven relay. */
async function worker(retainSentMs?: number): Promise<WorkerHarness> {
  const d1 = new SqliteD1(SQLITE_DDL);
  const waited: Promise<unknown>[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({
        type: 'custom',
        adapter: new D1Adapter(d1, { tables: { Outbox: { table: 'setu_outbox' } } }),
      }),
      MessagingPlugin({
        outbox: {
          store: createDatabaseOutboxStore(),
          relay: { schedule: false },
          // The platform's `waitUntil`: keeps the isolate alive for the sweep.
          background: (promise) => waited.push(promise),
          ...(retainSentMs !== undefined ? { retainSentMs } : {}),
        },
      }),
    ],
  });
  await app.start();
  const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
  const delivered: number[] = [];
  await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).subscribe(
    orderPlaced.topic,
    (message) => {
      delivered.push((message as { data: { n: number } }).data.n);
    },
  );
  const cron = new WorkersCron()
    .on(EVERY_MINUTE, async () => {
      await outbox.sweep();
    })
    .on(HOURLY, async () => {
      await outbox.purge();
    });
  const scheduled = createScheduledHandler(cron);
  return {
    app,
    d1,
    outbox,
    db: app.services.get<IDatabaseService>(CAPABILITIES.DATABASE),
    waited,
    delivered,
    fire: (expression) => scheduled({ cron: expression, scheduledTime: 0 }),
  };
}

/** Lets the in-memory broker deliver. */
function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('the Workers hybrid: D1 + dispatch via waitUntil + a Cron Trigger sweep', () => {
  it('starts with no scheduler and dispatch() hands exactly one sweep to waitUntil, which delivers', async () => {
    const h = await worker();
    try {
      expect(h.app.services.has(CAPABILITIES.SCHEDULER)).toBe(false);
      const id = await h.db.transaction((uow) => h.outbox.write(uow, orderPlaced, { n: 1 }));
      expect(h.delivered).toEqual([]);

      h.outbox.dispatch();
      expect(h.waited.length).toBe(1);
      await h.waited[0];
      await settle();

      expect(h.delivered).toEqual([1]);
      const stored = h.d1.dump('setu_outbox');
      expect(stored.map((r) => [r.id, r.status])).toEqual([[id, 'sent']]);
    } finally {
      await h.app.stop();
    }
  });

  it('a row written without dispatch is delivered by the every-minute Cron Trigger', async () => {
    const h = await worker();
    try {
      for (let n = 1; n <= 3; n++) {
        await h.db.transaction((uow) => h.outbox.write(uow, orderPlaced, { key: 'K', n }));
      }
      await settle();
      expect(h.delivered).toEqual([]);

      await h.fire(EVERY_MINUTE);
      await settle();

      expect(h.delivered).toEqual([1, 2, 3]);
      expect(h.waited).toEqual([]);
      expect(h.d1.dump('setu_outbox').every((r) => r.status === 'sent')).toBe(true);
    } finally {
      await h.app.stop();
    }
  });

  it('a slower Cron Trigger purges settled rows', async () => {
    const h = await worker(1);
    try {
      await h.db.transaction((uow) => h.outbox.write(uow, orderPlaced, { n: 1 }));
      await h.fire(EVERY_MINUTE);
      await settle(10);
      expect(h.d1.dump('setu_outbox').map((r) => r.status)).toEqual(['sent']);

      await h.fire(HOURLY);

      expect(h.d1.dump('setu_outbox')).toEqual([]);
    } finally {
      await h.app.stop();
    }
  });
});

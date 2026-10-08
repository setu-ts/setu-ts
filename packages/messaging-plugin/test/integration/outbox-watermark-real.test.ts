/**
 * The watermark negative control on REAL PostgreSQL (M107 §1, §3.6).
 *
 * Transaction A writes its outbox row and stays OPEN; transaction B writes and
 * commits; a relay tick runs (it can see only B); then A commits. A row that
 * commits BEHIND the relay's progress is exactly what a watermark relay loses:
 *
 * - the shipped pending-set relay publishes A on the next tick;
 * - an id watermark (a `bigserial` assigned at insert, the relay remembering
 *   the highest it has published) and a `createdAt` watermark — both
 *   implemented here as TEST-LOCAL queries, never product code — return no A
 *   at all: A is never published.
 *
 * Guarded with `ignore:` on `OUTBOX_POSTGRES_URL` (never an early return).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { postgresOutboxSchema } from '../../../database-plugin/test/fixtures/outbox-postgres.ts';

import { MessagingPlugin } from '../../src/index.ts';
import type { IOutbox } from '../../src/index.ts';
import { orderPlaced } from '../fixtures/outbox.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');

/** Lets the in-memory broker deliver. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('a row committing behind the relay (real PostgreSQL)', {
  ignore: postgresUrl === undefined,
}, () => {
  it('the pending-set relay publishes it on the next tick; an id or createdAt watermark loses it', async () => {
    // Two connections: transaction A holds one open while B commits on the other.
    const pg = await postgresOutboxSchema(postgresUrl!, true, 4);
    // The id watermark's sequence: assigned at INSERT time, like any serial id.
    await pg.pool.query('ALTER TABLE setu_outbox ADD COLUMN seq bigserial');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'custom', adapter: pg.adapter }),
        MessagingPlugin({
          outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
        }),
      ],
    });
    await app.start();
    try {
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const published: number[] = [];
      await broker.subscribe(orderPlaced.topic, (message) => {
        published.push((message as { data: { n: number } }).data.n);
      });

      // A: inserts, then waits — its transaction stays open.
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let aWritten!: () => void;
      const written = new Promise<void>((resolve) => {
        aWritten = resolve;
      });
      const transactionA = db.transaction(async (uow) => {
        const id = await outbox.write(uow, orderPlaced, { n: 1 });
        aWritten();
        await gate;
        return id;
      });
      await written;
      await settle(5);

      // B: inserts and commits while A is still open.
      const idB = await db.transaction((uow) => outbox.write(uow, orderPlaced, { n: 2 }));

      // Tick 1: only B is visible.
      const first = await outbox.sweep();
      await settle();
      expect(first.published).toBe(1);
      expect(published).toEqual([2]);

      // What a watermark relay would remember after tick 1: B's.
      const [b] = (await pg.pool.query(
        'SELECT seq, created_at FROM setu_outbox WHERE id = $1',
        [idB],
      )).rows as { seq: string; created_at: string }[];

      releaseA();
      const idA = await transactionA;
      const [a] = (await pg.pool.query(
        'SELECT seq, created_at, position FROM setu_outbox WHERE id = $1',
        [idA],
      )).rows as { seq: string; created_at: string; position: string }[];
      // A was inserted first, so it sits BEHIND B on every ordering column.
      expect(BigInt(a!.seq) < BigInt(b!.seq)).toBe(true);
      expect(Number(a!.created_at)).toBeLessThanOrEqual(Number(b!.created_at));

      // The two watermark variants, run against the same committed table.
      const idWatermark = (await pg.pool.query(
        "SELECT id FROM setu_outbox WHERE kind = 'setu-outbox' AND seq > $1 ORDER BY seq",
        [b!.seq],
      )).rows as { id: string }[];
      const createdAtWatermark = (await pg.pool.query(
        "SELECT id FROM setu_outbox WHERE kind = 'setu-outbox' AND created_at > $1 " +
          'ORDER BY created_at',
        [b!.created_at],
      )).rows as { id: string }[];
      expect(idWatermark.map((r) => r.id)).not.toContain(idA);
      expect(createdAtWatermark.map((r) => r.id)).not.toContain(idA);
      expect(idWatermark).toEqual([]);
      expect(createdAtWatermark).toEqual([]);

      // Tick 2: the pending-set relay reads A, committed behind its progress.
      const second = await outbox.sweep();
      await settle();
      expect(second.published).toBe(1);
      // The measured limit (§3.13): B committed first, so B published first.
      expect(published).toEqual([2, 1]);
      const statuses = (await pg.pool.query(
        'SELECT id, status FROM setu_outbox ORDER BY position',
      )).rows as { id: string; status: string }[];
      expect(statuses).toEqual([{ id: idA, status: 'sent' }, { id: idB, status: 'sent' }]);
    } finally {
      await app.stop();
      await pg.dispose();
    }
  });
});

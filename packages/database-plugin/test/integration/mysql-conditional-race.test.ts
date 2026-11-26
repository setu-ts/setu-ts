/** MYSQL_URL, like POSTGRES_URL, selects a shared backend and runs in isolation. */
import { describe, expect, it } from 'vitest';
import { VersionConflictError, updateVersioned } from '../../src/index.ts';
import { mysqlHarness } from '../fixtures/mysql-harness.ts';

const skipMysql = process.env['MYSQL_URL'] === undefined;
for (const type of ['prisma', 'drizzle'] as const) {
  describe(`${type} real MySQL conditional races`, { skip: skipMysql }, () => {
    it('has exactly one winner among 100 versioned writers and reads the winning row back', async () => {
      const h = await mysqlHarness(type);
      try {
        const repo = h.database.getRepository<{ id: string; version: number; balance: number }>(
          'Row',
        );
        await repo.create({ id: 'versioned', version: 1, balance: 100 });
        const results = await Promise.allSettled(
          Array.from({ length: 100 }, (_, balance) =>
            updateVersioned(repo, 'versioned', 1, { balance }),
          ),
        );
        const winners = results.filter((r) => r.status === 'fulfilled');
        const losers = results.filter((r) => r.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(99);
        for (const loser of losers)
          if (loser.status === 'rejected')
            expect(loser.reason).toBeInstanceOf(VersionConflictError);
        if (winners[0]?.status === 'fulfilled')
          expect(await repo.findById('versioned')).toEqual(winners[0].value);
      } finally {
        await h.dispose();
      }
    }, 30_000);
    for (const operation of ['update', 'delete', 'mixed'] as const) {
      it(`reports one winner among 20 ${operation} conditional writers`, async () => {
        const h = await mysqlHarness(type);
        try {
          const repo = h.database.getRepository('Row');
          await repo.create({ id: 'race', version: 1, balance: 100 });
          const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
              operation === 'delete' || (operation === 'mixed' && i % 2)
                ? repo.deleteWhere!('race', { version: 1 })
                : repo.updateWhere!('race', { version: 1 }, { version: 2, balance: i }),
            ),
          );
          const winners = results.filter(Boolean);
          expect(winners).toHaveLength(1);
          const stored = await repo.findById('race');
          expect(stored).toEqual(winners[0] === true ? null : winners[0]);
        } finally {
          await h.dispose();
        }
      });
    }
  });
}

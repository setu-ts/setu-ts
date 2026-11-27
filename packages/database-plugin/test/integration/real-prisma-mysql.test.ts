/** MYSQL_URL, like POSTGRES_URL, selects a shared backend and runs in isolation. */
import { describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '@setu-ts/common';
import type { EntityKey } from '@setu-ts/common';
import { mysqlHarness } from '../fixtures/mysql-harness.ts';
import { mysqlConditionCells } from '../fixtures/mysql-condition-cells.ts';

it(
  'mariadb serves FK, NOT NULL, length and lock timeout with rollback',
  { skip: !process.env['MYSQL_URL'] },
  async () => {
    await mysqlConditionCells('prisma');
  },
);

describe('Prisma real MySQL repository', { skip: !process.env['MYSQL_URL'] }, () => {
  it('conjoins composite keys and tenant predicates on root and transaction clients', async () => {
    const h = await mysqlHarness('prisma');
    try {
      const repo = h.database.getRepository<Record<string, unknown>, EntityKey>('Compound');
      const key = { tenantId: 'a', id: 'row' };
      await repo.create({ ...key, version: 1, balance: 100 });
      expect(await repo.updateWhere!(key, { tenantId: 'b' }, { balance: 0 })).toBeNull();
      await h.database.transaction(async (uow) => {
        const tx = uow.getRepository<Record<string, unknown>, EntityKey>('Compound');
        expect(await tx.updateWhere!(key, { version: 1 }, { version: 2 })).toMatchObject({
          version: 2,
        });
        expect(await tx.deleteWhere!(key, { version: 1 })).toBe(false);
      });
      expect(await repo.findById(key)).toMatchObject({ balance: 100, version: 2 });
      await h.database.query('INSERT INTO `rows` (id, version, balance) VALUES (?, ?, ?)', [
        'duplicate',
        1,
        100,
      ]);
      await expect(
        h.database.query('INSERT INTO `rows` (id, version, balance) VALUES (?, ?, ?)', [
          'duplicate',
          1,
          100,
        ]),
      ).rejects.toBeInstanceOf(DuplicateKeyError);
    } finally {
      await h.dispose();
    }
  });
});

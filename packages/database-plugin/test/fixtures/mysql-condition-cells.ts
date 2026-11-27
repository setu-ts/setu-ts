import { expect } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { mysqlHarness } from './mysql-harness.ts';

/** Same real constraints on mysql2 and mariadb; every fixture owns its database. */
export async function mysqlConditionCells(type: 'drizzle' | 'prisma'): Promise<void> {
  const h = await mysqlHarness(type, 4, 'prisma-client-generated-mysql', 1);
  // Pin and initialize every mysql2 session before handing it to Drizzle.
  const sessions = await Promise.all(Array.from({ length: 4 }, () => h.pool.getConnection()));
  try {
    for (const session of sessions) await session.query('SET SESSION innodb_lock_wait_timeout = 1');
  } finally {
    for (const session of sessions) session.release();
  }
  try {
    await h.pool.query('CREATE TABLE condition_parent (id varchar(191) PRIMARY KEY)');
    await h.pool.query(
      'ALTER TABLE `rows` ADD FOREIGN KEY (tenant_id) REFERENCES condition_parent(id)',
    );
    await h.pool.query('ALTER TABLE `rows` MODIFY name varchar(8)');
    const repo = h.database.getRepository<Record<string, unknown>>('Row');
    for (const [label, work, status, slug] of [
      [
        'foreign key',
        () => repo.create({ id: 'fk', tenant_id: 'missing', version: 1, balance: 1 }),
        409,
        'foreign-key-violation',
      ],
      [
        'not null',
        () =>
          h.database.query('INSERT INTO `rows` (id, version, balance) VALUES (?, ?, ?)', [
            'null',
            1,
            null,
          ]),
        400,
        'not-null-violation',
      ],
      [
        'length',
        () => repo.create({ id: 'long', name: '1234567890123456', version: 1, balance: 1 }),
        400,
        'invalid-field-value',
      ],
    ] as const) {
      const error = await work().catch((value: unknown) => value);
      expect(httpStatusHintOf(error)?.status, label).toBe(status);
      expect(httpStatusHintOf(error)?.problem?.type, label).toBe(
        `https://setu-ts.dev/errors/${slug}`,
      );
      expect(await repo.count(), label).toBe(0);
    }
    await repo.create({ id: 'lock', name: 'before', version: 1, balance: 1 });
    const holder = await h.pool.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query('UPDATE `rows` SET balance = 2 WHERE id = ?', ['lock']);
      const error = await h.database
        .transaction(async (uow) => {
          // This earlier write must roll back when the later statement times out.
          await uow.getRepository('Row').create({ id: 'rolled', version: 1, balance: 1 });
          await uow.getRepository('Row').update('lock', { name: 'after' });
        })
        .catch((value: unknown) => value);
      expect(httpStatusHintOf(error)?.status).toBe(409);
      expect(httpStatusHintOf(error)?.problem?.type).toBe(
        'https://setu-ts.dev/errors/lock-timeout',
      );
    } finally {
      await holder.rollback();
      holder.release();
    }
    expect(await repo.findById('rolled')).toBeNull();
    expect(await repo.findById('lock')).toMatchObject({ name: 'before', balance: 1 });
  } finally {
    await h.dispose();
  }
}

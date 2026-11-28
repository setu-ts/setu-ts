import { expect } from 'vitest';
import type { Pool } from 'pg';
import type { IDatabaseService } from '../../src/index.ts';
import { httpStatusHintOf } from '@setu-ts/common';

/** Real server refusals, with an earlier write proving unit-of-work rollback. */
export async function postgresConditionCells(
  db: IDatabaseService,
  pool: Pool,
  table: string,
  entity: string,
  validData: Record<string, unknown>,
  lengthData: Record<string, unknown>,
  lockWrite?: () => Promise<unknown>,
): Promise<void> {
  const repo = db.getRepository<Record<string, unknown>>(entity);
  for (const [label, work, status, slug] of [
    [
      'FK',
      () => db.query(`INSERT INTO ${table} (id, parent_id, label) VALUES ('fk', 'missing', 'ok')`),
      409,
      'foreign-key-violation',
    ],
    [
      'NOT NULL',
      () => db.query(`INSERT INTO ${table} (id, label) VALUES ('null', NULL)`),
      400,
      'not-null-violation',
    ],
    ['length', () => repo.create(lengthData), 400, 'invalid-field-value'],
  ] as const) {
    const error = await work().catch((value: unknown) => value);
    expect(httpStatusHintOf(error)?.status, label).toBe(status);
    expect(httpStatusHintOf(error)?.problem?.type, label).toBe(
      `https://setu-ts.dev/errors/${slug}`,
    );
    expect(await repo.count(), label).toBe(0);
  }
  await repo.create(validData);
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`UPDATE ${table} SET label = 'held' WHERE id = 'lock'`);
    const error = await (
      lockWrite?.() ??
      db.transaction(async (uow) => {
        const scoped = uow.getRepository(entity);
        await scoped.create({ ...validData, id: 'rolled' });
        await scoped.update('lock', { label: 'after' });
      })
    ).catch((value: unknown) => value);
    expect(httpStatusHintOf(error)?.status).toBe(409);
    expect(httpStatusHintOf(error)?.problem?.type).toBe('https://setu-ts.dev/errors/lock-timeout');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  expect(await repo.findById('rolled')).toBeNull();
  expect(await repo.findById('lock')).toMatchObject({ label: 'before' });
}

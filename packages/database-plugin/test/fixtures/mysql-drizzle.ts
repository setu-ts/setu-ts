import type { DrizzleInstance } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createFakeDrizzleInstance, createFakeDrizzleTable } from './fake-drizzle-instance.ts';

/** A mysql2-shaped recording database; builders execute only when awaited. */
export function mysqlDrizzle(shape: 'tuple' | 'bare' | 'unknown' = 'tuple') {
  const native = createFakeDrizzleInstance();
  const table = createFakeDrizzleTable('user');
  let transactions = 0;
  let changedOnly = false;
  let emptyIds = false;
  let connectionError: Error | undefined;
  const result = (run: () => Promise<Record<string, unknown>[]>) => ({
    then: <T = unknown, E = never>(
      yes?: ((value: unknown) => T | PromiseLike<T>) | null,
      no?: ((reason: unknown) => E | PromiseLike<E>) | null,
    ): Promise<T | E> =>
      run()
        .then((rows) => {
          const header = { affectedRows: changedOnly ? 0 : rows.length };
          return shape === 'unknown'
            ? { rowsAffected: rows.length }
            : shape === 'bare'
              ? header
              : [header, []];
        })
        .then(yes, no),
    $returningId: async () => (emptyIds ? [] : (await run()).map((row) => ({ id: row.id }))),
  });
  const db: DrizzleInstance = {
    select: native.select,
    insert: (target) => ({
      values: (data) => result(() => native.insert(target).values(data).returning()),
    }),
    // MySQL stores a number written to the VARCHAR key as text, as the real column does.
    update: (target) => ({
      set: (data) => ({
        where: (expr) =>
          result(() =>
            native
              .update(target)
              .set(typeof data['id'] === 'number' ? { ...data, id: String(data['id']) } : data)
              .where(expr)
              .returning(),
          ),
      }),
    }),
    delete: (target) => ({
      where: (expr) => result(() => native.delete(target).where(expr).returning()),
    }),
    transaction: async (run) => {
      transactions += 1;
      if (connectionError) throw connectionError;
      const before = new Map(native.stores.user!.records);
      try {
        return await run(db);
      } catch (error) {
        native.stores.user!.records = before;
        throw error;
      }
    },
  };
  return {
    db,
    table,
    native,
    get transactions() {
      return transactions;
    },
    set changedOnly(value: boolean) {
      changedOnly = value;
    },
    set emptyIds(value: boolean) {
      emptyIds = value;
    },
    set connectionError(value: Error) {
      connectionError = value;
    },
  };
}

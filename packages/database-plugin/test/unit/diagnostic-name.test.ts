import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase } from '../../src/query/drizzle-database.ts';
import { UnknownPayloadFieldError } from '../../src/errors.ts';
import { unknownColumnError } from '../../src/query/query-builder.ts';

describe('bounded names in database diagnostics', () => {
  for (const [field, rendered] of [
    ['field\r\nforged\t"\\', '"field\\r\\nforged\\t\\"\\\\"'],
    ['x'.repeat(64), `"${'x'.repeat(64)}"`],
    ['x'.repeat(200), `"${'x'.repeat(64)}"…`],
    ['😀'.repeat(33), `"${'😀'.repeat(32)}"…`],
  ] as const) {
    it(`quotes and bounds a ${field.length}-code-unit name in all three messages`, async () => {
      const database = drizzle(() => {
        throw new Error('an unknown column must be refused before I/O');
      });
      const adapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(database, (db, work) => db.transaction(work)),
        drizzleTables: { User: pgTable('users', { id: text('id').primaryKey() }) },
      });
      await adapter.connect();
      try {
        const source = adapter.createDataSource('User');
        const messages = [new UnknownPayloadFieldError('User', field).message];
        for (const query of [
          { select: [field] },
          { orderBy: { [field]: 'asc' as const } },
          { where: { [field]: 'value' } },
        ]) {
          const error: unknown = await source
            .findAll({
              where: {},
              orderBy: {},
              select: [],
              limit: -1,
              offset: 0,
              ...query,
            })
            .catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            `Drizzle table 'User' has no ${rendered} column required by the database repository.`,
          );
          messages.push((error as Error).message);
        }
        const memoryError = unknownColumnError('User', [{ id: '1' }], {
          select: [field],
          orderBy: {},
        });
        expect(memoryError?.message).toBe(
          `Memory adapter: entity 'User' has no ${rendered} column for select. Known columns: "id".`,
        );
        messages.push(memoryError!.message);
        expect(messages[0]).toBe(`Entity 'User' has no payload field ${rendered}.`);
        for (const message of messages) {
          expect(message).not.toMatch(/[\r\n]/);
          expect(message).not.toContain('x'.repeat(65));
        }
      } finally {
        await adapter.disconnect();
      }
    });
  }

  it('quotes and bounds EACH known memory column, retaining sorted order', () => {
    const error = unknownColumnError(
      'User',
      [
        {
          'z\r\nforged': 1,
          ['x'.repeat(200)]: 2,
          'a\r\nfirst': 3,
        },
      ],
      { select: [], orderBy: { missing: 'asc' } },
    );
    expect(error?.message).toBe(
      'Memory adapter: entity \'User\' has no "missing" column for orderBy. ' +
        `Known columns: "a\\r\\nfirst", "${'x'.repeat(64)}"…, "z\\r\\nforged".`,
    );
    expect(error?.message).not.toMatch(/[\r\n]/);
    expect(error?.message).not.toContain('x'.repeat(65));
  });
});

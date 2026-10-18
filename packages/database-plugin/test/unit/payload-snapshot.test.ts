/**
 * Every Drizzle write checks and writes ONE snapshot of its payload, and the
 * Prisma update paths send no key column once the unchanged-key check passed
 * (M113g, PR #470 review).
 */
import { describe, expect, it } from 'vitest';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createDrizzleDataSource } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createPrismaDataSource } from '../../src/adapters/prisma/prisma-adapter.ts';
import { UnknownPayloadFieldError } from '../../src/errors.ts';

const operators = { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql };
const item = pgTable('item', { id: text('id').primaryKey(), value: integer('value') });

/** A field that reads `undefined` first and a value afterwards. */
function flipping(): Record<string, unknown> {
  let reads = 0;
  return {
    value: 1,
    get bogus() {
      reads += 1;
      return reads === 1 ? undefined : 'smuggled';
    },
  };
}

/** A Drizzle instance recording every payload it is asked to write. */
function recordingDrizzle(written: Record<string, unknown>[]): never {
  const returning = { returning: () => Promise.resolve([{ id: 'a', value: 1 }]) };
  return {
    insert: () => ({
      values: (data: Record<string, unknown>) => (written.push({ ...data }), returning),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => (
        written.push({ ...data }),
        { where: () => returning, ...returning }
      ),
    }),
  } as never;
}

describe('Drizzle writes read the payload once', () => {
  for (const [label, write] of [
    ['create', (source: ReturnType<typeof createDrizzleDataSource>) => source.create(flipping())],
    [
      'updateWhere',
      (source: ReturnType<typeof createDrizzleDataSource>) =>
        source.updateWhere!('a', { value: 1 }, flipping()),
    ],
  ] as const) {
    it(`${label} cannot be shown undefined by the check and a value by the write`, async () => {
      const written: Record<string, unknown>[] = [];
      const source = createDrizzleDataSource(
        recordingDrizzle(written),
        'item',
        { item },
        operators as never,
      );
      const result = await write(source).then(
        () => 'written',
        (error: unknown) => error,
      );
      // Either the snapshot carried `bogus: undefined` (dropped, nothing
      // smuggled) or the check saw the value and refused it: never a write of
      // a field the check did not see.
      for (const payload of written) expect(payload['bogus']).toBeUndefined();
      if (result !== 'written') expect(result).toBeInstanceOf(UnknownPayloadFieldError);
    });
  }
});

describe('Prisma update paths drop an accepted key column', () => {
  function recordingPrisma(sent: Record<string, unknown>[]) {
    const client = {
      item: {
        update: (args: { data: Record<string, unknown> }) => {
          sent.push(args.data);
          return Promise.resolve({ id: '5', value: 2 });
        },
      },
    };
    return createPrismaDataSource(client as never, 'Item', 'postgresql');
  }

  it('update sends no key column when the key is equal by string', async () => {
    const sent: Record<string, unknown>[] = [];
    await recordingPrisma(sent).update('5', { id: 5, value: 2 });
    expect(sent).toEqual([{ value: 2 }]);
  });

  it('updateWhere sends no key column when the key is equal by string', async () => {
    const sent: Record<string, unknown>[] = [];
    await recordingPrisma(sent).updateWhere!('5', { value: 1 }, { id: 5, value: 2 });
    expect(sent).toEqual([{ value: 2 }]);
  });

  it('still refuses a changed key before any write', async () => {
    const sent: Record<string, unknown>[] = [];
    await expect(recordingPrisma(sent).update('5', { id: 6 })).rejects.toThrow(
      /cannot change the primary key/,
    );
    expect(sent).toEqual([]);
  });
});

/**
 * Tests for the Prisma fixture's `where` evaluator.
 *
 * The fixture's contract is to evaluate "the `where` input a real Prisma client
 * would receive" — so its logical operators are pinned against semantics
 * MEASURED on real Prisma 7.10 against live PostgreSQL, not against what the
 * grammar looks like it should mean. A double that disagrees with the real
 * client is the recurring root cause behind several findings in this
 * repository, and it fails in the direction that makes a broken adapter look
 * correct.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import type { PrismaAdapterOptions } from '../../src/interfaces/index.ts';

/** The delegate surface these cases drive. */
interface Delegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: { where?: Record<string, unknown> }): Promise<Record<string, unknown>[]>;
  count(args: { where?: Record<string, unknown> }): Promise<number>;
  update(
    args: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<Record<string, unknown>>;
  delete(args: { where: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Four rows spanning two conditions, the same shape the live Prisma probe
 * used: A is `userId === 'a'`, B is `city === 'X'`.
 *
 * | row | A | B |
 * | --- | - | - |
 * | r1  | ✓ | ✓ |
 * | r2  | ✓ |   |
 * | r3  |   | ✓ |
 * | r4  |   |   |
 */
async function seeded(): Promise<Delegate> {
  const client = createFakePrismaClient() as unknown as Record<string, Delegate>;
  const model = client.user;
  await model.create({ data: { id: 'r1', userId: 'a', city: 'X' } });
  await model.create({ data: { id: 'r2', userId: 'a', city: 'Y' } });
  await model.create({ data: { id: 'r3', userId: 'b', city: 'X' } });
  await model.create({ data: { id: 'r4', userId: 'b', city: 'Y' } });
  return model;
}

const A = { userId: 'a' };
const B = { city: 'X' };

/** The matching ids for a `where`, sorted. */
async function ids(model: Delegate, where: Record<string, unknown>): Promise<string[]> {
  const found = await model.findMany({ where });
  return found.map((r) => String(r.id)).sort();
}

describe('the Prisma fixture evaluates NOT as Prisma does', () => {
  it('excludes the rows a singleton NOT names', async () => {
    // Without a NOT arm this fell through to the compound-key branch and
    // MATCHED the rows it was asked to exclude — fully inverted.
    const model = await seeded();
    expect(await ids(model, { NOT: A })).toEqual(['r3', 'r4']);
    expect(await ids(model, { NOT: B })).toEqual(['r2', 'r4']);
  });

  it('reads an ARRAY NOT as "neither", the measured Prisma semantics', async () => {
    // Measured on real Prisma 7.10 over this exact fixture: `NOT: [A, B]`
    // returns only the row matching NEITHER. So the array negates each
    // condition and ANDs them, rather than negating their conjunction —
    // `NOT (A AND B)` would return three rows (r2, r3, r4).
    const model = await seeded();
    expect(await ids(model, { NOT: [A, B] })).toEqual(['r4']);
    expect(await ids(model, { NOT: [A, B] })).not.toEqual(['r2', 'r3', 'r4']);
  });

  it('treats an empty NOT array as no constraint', async () => {
    const model = await seeded();
    expect(await ids(model, { NOT: [] })).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('composes NOT with the other operators', async () => {
    const model = await seeded();
    // A AND NOT B — matches A, does not match B.
    expect(await ids(model, { AND: [A], NOT: B })).toEqual(['r2']);
    // Nested inside AND.
    expect(await ids(model, { AND: [{ NOT: A }, { NOT: B }] })).toEqual(['r4']);
    // Double negation resolves.
    expect(await ids(model, { NOT: { NOT: A } })).toEqual(['r1', 'r2']);
  });

  it('applies NOT on count, update and delete, not only findMany', async () => {
    // The evaluator is shared, so all four entry points were inverted together.
    const model = await seeded();
    expect(await model.count({ where: { NOT: A } })).toBe(2);

    const updated = await model.update({ where: { NOT: A }, data: { city: 'Z' } });
    // The first row NOT matching A is r3.
    expect(updated.id).toBe('r3');

    await model.delete({ where: { NOT: A } });
    expect(await ids(model, {})).toEqual(['r1', 'r2', 'r4']);
  });
});

describe('the Prisma fixture accepts a singleton AND/OR, as Prisma does', () => {
  it('reads a singleton AND object, not only an array', async () => {
    // A bare `as Record<string, unknown>[]` cast left `.every` undefined and
    // threw a TypeError on the object form Prisma accepts.
    const model = await seeded();
    expect(await ids(model, { AND: A })).toEqual(['r1', 'r2']);
    expect(await ids(model, { AND: [A] })).toEqual(['r1', 'r2']);
  });

  it('reads a singleton OR object, not only an array', async () => {
    const model = await seeded();
    expect(await ids(model, { OR: B })).toEqual(['r1', 'r3']);
    expect(await ids(model, { OR: [B] })).toEqual(['r1', 'r3']);
  });

  it('keeps the multi-clause array semantics', async () => {
    const model = await seeded();
    expect(await ids(model, { AND: [A, B] })).toEqual(['r1']);
    expect(await ids(model, { OR: [A, B] })).toEqual(['r1', 'r2', 'r3']);
  });
});

describe("the adapter's own NOT-emitting path evaluates through the fixture", () => {
  it('matches nothing for an empty nested-path `in`, end to end', async () => {
    // `prisma-adapter.ts` emits `NOT` at exactly one site: the empty
    // nested-path `in`, compiled to `AND: [{path equals ''}, {NOT: same}]` —
    // a deliberate match-nothing predicate. Until the fixture understood
    // `NOT`, that clause fell through to the compound-key branch, so a
    // predicate designed to match nothing was evaluated as something else.
    // This drives the REAL adapter, so the emitted shape and the fixture's
    // reading of it are checked together rather than separately.
    const fake = createFakePrismaClient({ activeProvider: 'postgresql' });
    const adapter = new PrismaAdapter({ prismaClient: fake } as PrismaAdapterOptions);
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await source.create({ id: 'u1', profile: { city: 'Kolkata' } });
    await source.create({ id: 'u2', profile: { city: 'Delhi' } });

    const query = (filter: unknown) =>
      ({
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
        filter,
      }) as never;

    const empty = await source.findAll(query({
      type: 'comparison',
      field: ['profile', 'city'],
      operator: 'in',
      value: [],
    }));
    expect(empty).toEqual([]);

    // The non-empty case is the control: the same path must still match.
    const one = await source.findAll(query({
      type: 'comparison',
      field: ['profile', 'city'],
      operator: 'in',
      value: ['Kolkata'],
    }));
    expect(one.map((r) => r.id)).toEqual(['u1']);
  });
});

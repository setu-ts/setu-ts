import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { checkWritePrecondition } from '../../src/index.ts';
import type { WritePrecondition } from '../../src/index.ts';

/** The refusal reason, or `undefined` when the inputs are accepted. */
function problemOf(...args: [unknown] | [unknown, unknown]): string | undefined {
  const checked = args.length === 1
    ? checkWritePrecondition(args[0])
    : checkWritePrecondition(args[0], args[1]);
  return checked.ok ? undefined : checked.problem;
}

describe('portable write preconditions', () => {
  const accepted: WritePrecondition[] = [
    { status: 'pending' },
    { kind: 'x', attempts: 2 },
    {
      id: 'y',
    },
    Object.assign(Object.create(null), { n: 1 }),
    { n: -0 },
    { n: Number.MAX_VALUE },
  ];
  for (const where of accepted) {
    it(`accepts ${JSON.stringify(where)}`, () => {
      expect(problemOf(where)).toBeUndefined();
      expect(problemOf(where, { status: 'sent' })).toBeUndefined();
    });
  }
  const refused: unknown[] = [
    undefined,
    null,
    [],
    new Date(0),
    'x',
    {},
    Object.create({ inherited: 1 }),
    { n: null },
    { n: false },
    { n: new Date(0) },
    { n: {} },
    { n: [] },
    { n: undefined },
    { n: Number.NaN },
    { n: Number.POSITIVE_INFINITY },
    { n: Number.NEGATIVE_INFINITY },
    { '': 'x' },
    { $where: 'x' },
    { 'a.b': 1 },
  ];
  for (const [index, where] of refused.entries()) {
    it(`refuses input ${index} without echoing caller input`, () => {
      const problem = problemOf(where);
      expect(typeof problem).toBe('string');
      expect(problem).not.toContain('$where');
      expect(problem).not.toContain('a.b');
      expect(problemOf(where, { n: 2 })).toBeDefined();
    });
  }
  it('refuses empty, undefined and non-plain update payloads', () => {
    for (const data of [{}, undefined, null, [], 'x', new Date(0), Object.create({ n: 1 })]) {
      expect(problemOf({ status: 'pending' }, data)).toBeDefined();
    }
  });

  it('returns private copies, so later changes to the inputs never reach the write', () => {
    const where: Record<string, unknown> = { status: 'pending' };
    const data: Record<string, unknown> = { status: 'sent' };
    const checked = checkWritePrecondition(where, data);
    if (!checked.ok) throw new Error(checked.problem);
    where.status = 'other';
    where.$where = 'true';
    data.status = 'hijacked';
    expect(checked.where).toEqual({ status: 'pending' });
    expect(checked.data).toEqual({ status: 'sent' });
    expect(checked.where).not.toBe(where);
    expect(checked.data).not.toBe(data);
  });

  it('reads each field of a key-swapping Proxy once and validates what it read', () => {
    let reads = 0;
    const swapping = new Proxy({ tenant_id: 'a' } as Record<string, unknown>, {
      get(target, key) {
        reads += 1;
        // Answers a legitimate value to the first read, an operator to any later one.
        return reads === 1 ? Reflect.get(target, key) : { $ne: 'a' };
      },
    });
    const checked = checkWritePrecondition(swapping);
    expect(checked).toEqual({ ok: true, where: { tenant_id: 'a' }, data: undefined });
    expect(reads).toBe(1);
  });

  it('refuses an own __proto__ field in the predicate and in the payload', () => {
    // Node and Bun drop `__proto__` from any object a backend rebuilds by
    // assignment, so carrying it would silently remove a condition.
    const where = JSON.parse('{"__proto__":"x","n":1}') as Record<string, unknown>;
    expect(problemOf(where)).toMatch(/__proto__/);
    expect(problemOf({ n: 1 }, JSON.parse('{"__proto__":{"isAdmin":true}}'))).toMatch(/__proto__/);
    expect(problemOf({ n: 1 }, JSON.parse('{"__proto__":1,"name":"x"}'))).toMatch(/__proto__/);
    // `constructor` is an ordinary own field name and stays accepted.
    expect(problemOf({ constructor: 'x' }, { constructor: 'y' })).toBeUndefined();
  });
});

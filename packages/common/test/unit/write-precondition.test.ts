import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { writePreconditionProblem } from '../../src/index.ts';
import type { WritePrecondition } from '../../src/index.ts';

describe('portable write preconditions', () => {
  const accepted: WritePrecondition[] = [{ status: 'pending' }, { kind: 'x', attempts: 2 }, {
    id: 'y',
  }, Object.assign(Object.create(null), { n: 1 })];
  for (const where of accepted) {
    it(`accepts ${JSON.stringify(where)}`, () => {
      expect(writePreconditionProblem(where)).toBeUndefined();
      expect(writePreconditionProblem(where, { status: 'sent' })).toBeUndefined();
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
    { '': 'x' },
    { $where: 'x' },
    { 'a.b': 1 },
  ];
  for (const [index, where] of refused.entries()) {
    it(`refuses input ${index} without echoing caller input`, () => {
      expect(typeof writePreconditionProblem(where)).toBe('string');
      expect(writePreconditionProblem(where, { n: 2 })).toBeDefined();
    });
  }
  it('refuses empty, undefined and non-plain update payloads', () => {
    for (const data of [{}, undefined, null, [], 'x', new Date(0), Object.create({ n: 1 })]) {
      expect(writePreconditionProblem({ status: 'pending' }, data)).toBeDefined();
    }
  });
});

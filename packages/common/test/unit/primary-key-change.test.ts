import { describe, expect, it } from 'vitest';
import {
  assertPrimaryKeyUnchanged,
  PrimaryKeyChangeError,
  httpStatusHintOf,
} from '../../src/index.ts';

describe('primary key immutability', () => {
  it('reads each own key value exactly once', () => {
    let reads = 0;
    const data = {
      get id() {
        reads += 1;
        return reads === 1 ? '5' : 'changed';
      },
    };
    assertPrimaryKeyUnchanged('User', ['id'], '5', data);
    expect(reads).toBe(1);
  });
  const objectId = { toHexString: () => 'abc', toString: () => 'abc' };
  const shared = {};
  for (const [addressed, supplied] of [
    ['5', 5],
    [5, '5'],
    [5n, '5'],
    [new Date(10), new Date(10)],
    ['abc', objectId],
    [objectId, 'abc'],
    [shared, shared],
    [true, true],
    [null, null],
  ]) {
    it(`accepts equivalent ${String(addressed)} identities`, () => {
      expect(() =>
        assertPrimaryKeyUnchanged('SecretEntity', ['id'], { id: addressed }, { id: supplied }),
      ).not.toThrow();
    });
  }
  for (const [addressed, supplied] of [
    [5, 6],
    [new Date(10), new Date(11)],
    [{}, {}],
    [false, true],
    [null, undefined],
  ]) {
    it(`refuses a changed identity ${String(addressed)} when supplied`, () => {
      const run = () =>
        assertPrimaryKeyUnchanged('SecretEntity', ['id'], { id: addressed }, { id: supplied });
      if (supplied === undefined) expect(run).not.toThrow();
      else expect(run).toThrow(PrimaryKeyChangeError);
    });
  }
  it('compares scalar, composite, own and undefined fields without mutating input', () => {
    assertPrimaryKeyUnchanged('User', ['id'], '5', { id: 5 });
    assertPrimaryKeyUnchanged('User', ['tenant', 'id'], { tenant: 't', id: 5 }, { id: '5' });
    expect(() =>
      assertPrimaryKeyUnchanged(
        'User',
        ['tenant', 'id'],
        { tenant: 't', id: 5 },
        { tenant: 'different' },
      ),
    ).toThrow(PrimaryKeyChangeError);
    assertPrimaryKeyUnchanged('User', ['id'], '5', { id: undefined });
    assertPrimaryKeyUnchanged(
      'User',
      ['id'],
      '5',
      Object.create({ id: 'different' }) as Record<string, unknown>,
    );
    for (const id of [undefined, null, [], true, {}, { other: 1 }]) {
      assertPrimaryKeyUnchanged('User', ['id'], id, { id: 'different' });
    }
    assertPrimaryKeyUnchanged('User', ['tenant', 'id'], 'scalar', { id: 'different' });
    assertPrimaryKeyUnchanged('User', ['id'], new Date(10), { id: new Date(10) });
    assertPrimaryKeyUnchanged('User', ['id'], objectId, { id: 'abc' });
    assertPrimaryKeyUnchanged('User', ['id'], '5', {});
  });
  it('carries a fixed 400 hint and no value in diagnostics', () => {
    const error = new PrimaryKeyChangeError('User', 'id');
    expect(error.name).toBe('PrimaryKeyChangeError');
    expect(error.message).toContain('User');
    expect(error.message).toContain('id');
    expect(httpStatusHintOf(error)).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: "An update cannot change a row's primary key.",
    });
    expect(() =>
      assertPrimaryKeyUnchanged('User', ['id'], 'private-old', { id: 'private-new' }),
    ).toThrow(error.message);
  });
});

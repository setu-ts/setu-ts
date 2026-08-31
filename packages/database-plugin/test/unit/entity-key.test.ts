/**
 * Unit tests for the shared key-resolution utilities in `query/key-target.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { keyValues, resolveKeyColumns } from '../../src/query/key-target.ts';

describe('resolveKeyColumns', () => {
  it("yields ['id'] for a scalar 'id'", () => {
    expect(resolveKeyColumns('id')).toEqual(['id']);
  });

  it('passes through an array form unchanged', () => {
    expect(resolveKeyColumns(['tenantId', 'userId'])).toEqual(['tenantId', 'userId']);
  });

  it('yields a one-element array for a single-column list', () => {
    expect(resolveKeyColumns(['id'])).toEqual(['id']);
  });

  it('refuses an EMPTY column list where the mapping is read', () => {
    // An empty list passes every downstream shape check while producing no
    // predicates at all — a Drizzle `update`/`delete` would address EVERY ROW
    // and D1 would emit a malformed `WHERE`/`RETURNING`. There is no honest
    // default to pick, so it is a configuration fault raised at the mapping
    // rather than a silently destructive query at the first write.
    expect(() => resolveKeyColumns([])).toThrow(/must name at least one column/);
  });
});

describe('keyValues', () => {
  it('returns a scalar wrapped in a one-element array for a scalar against a one-column target', () => {
    expect(keyValues('abc', ['id'], 'findById')).toEqual(['abc']);
    expect(keyValues(42, ['id'], 'findById')).toEqual([42]);
  });

  it('refuses a scalar against a multi-column target, naming the operation and first column', () => {
    let err: Error | undefined;
    try {
      keyValues('abc', ['tenantId', 'userId'], 'update');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('update');
    expect(err!.message).toContain('tenantId');
    expect(err!.message).toContain('scalar');
  });

  it('projects a composite record onto columns in order', () => {
    expect(
      keyValues({ tenantId: 't1', userId: 7 }, ['tenantId', 'userId'], 'findById'),
    ).toEqual(['t1', 7]);
  });

  it('refuses a record missing a column, naming the column', () => {
    let err: Error | undefined;
    try {
      keyValues({ tenantId: 't1' }, ['tenantId', 'userId'], 'delete');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('delete');
    expect(err!.message).toContain('userId');
    expect(err!.message).toContain('missing');
  });

  it('accepts a composite record that has all required columns', () => {
    expect(
      keyValues({ a: 'x', b: 1 }, ['a', 'b'], 'update'),
    ).toEqual(['x', 1]);
  });
});

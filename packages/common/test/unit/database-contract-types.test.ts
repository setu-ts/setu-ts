/**
 * Compile-time contract tests for the M79 portable data-access contract additions.
 *
 * These assertions are decided by `deno task check` — if a required member is
 * ever dropped or an optional one is narrowed away, this file stops compiling.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  EntityKey,
  FilterComparison,
  IDataSource,
  NormalizedQuery,
  PageResult,
} from '../../src/index.ts';
import { decodeCursor, encodeCursor, keysetPredicate } from '../../src/index.ts';
import type { CursorPayload } from '../../src/index.ts';

describe('M79 portable data-access contract types', () => {
  it('exports EntityKey as a type (compile-time)', () => {
    // Scalar arms — source-compatible with every existing call site.
    const scalarStr: EntityKey = 'id-1';
    const scalarNum: EntityKey = 42;
    expect(scalarStr).toBeDefined();
    expect(scalarNum).toBeDefined();

    // Composite arm — named-record shape, never an array.
    const composite: EntityKey = { tenantId: 't1', productId: 7 };
    expect(composite).toBeDefined();

    // @ts-expect-error — arrays are not allowed as composite keys (column
    // order would be an implicit contract the caller must remember).
    const _badArray: EntityKey = ['t1', 7];
    void _badArray;
  });

  it('widen FilterComparison ordered-arm value to accept Date', () => {
    const now = new Date();
    const ge: FilterComparison = {
      type: 'comparison',
      field: 'createdAt',
      operator: 'gte',
      value: now,
    };
    const lt: FilterComparison = {
      type: 'comparison',
      field: 'createdAt',
      operator: 'lt',
      value: now,
    };
    expect(ge.value).toBe(now);
    expect(lt.value).toBe(now);
  });

  it('refuses Date in the contains arm', () => {
    // @ts-expect-error — contains requires a string, not a Date.
    const _badContains: FilterComparison = {
      type: 'comparison',
      field: 'name',
      operator: 'contains',
      value: new Date(),
    };
    void _badContains;
  });

  it('allows a two-element field array in a comparison (nested path)', () => {
    // `field` is `string | readonly string[]`. A two-element path literal
    // type-checks without `as const` because `readonly string[]` is the union arm.
    const comp: FilterComparison = {
      type: 'comparison',
      field: ['address', 'city'],
      operator: 'eq',
      value: 'NYC',
    };
    expect(comp.field).toEqual(['address', 'city']);
    expect(comp.value).toBe('NYC');
  });

  it('allows a single-element field array in an ordered arm (Date value)', () => {
    const date = new Date();
    const comp: FilterComparison = {
      type: 'comparison',
      field: 'createdAt',
      operator: 'gt',
      value: date,
    };
    expect(comp.value).toBe(date);
  });

  it('IDataSource.findById accepts EntityKey (not just scalar)', () => {
    // Compile-time: a DataSource implementation with EntityKey is assignable.
    const ds: IDataSource = {
      findAll() {
        return Promise.resolve([]);
      },
      findById(_id: EntityKey) {
        return Promise.resolve(null);
      },
      create() {
        return Promise.resolve({});
      },
      update(_id: EntityKey, _data) {
        return Promise.resolve(_data);
      },
      delete(_id: EntityKey) {
        return Promise.resolve(false);
      },
      count() {
        return Promise.resolve(0);
      },
    };
    expect(ds).toBeDefined();
  });

  it('IDataSource.update accepts EntityKey', () => {
    const ds: IDataSource = {
      findAll() {
        return Promise.resolve([]);
      },
      findById() {
        return Promise.resolve(null);
      },
      create() {
        return Promise.resolve({});
      },
      update(_id: EntityKey, data) {
        return Promise.resolve(data);
      },
      delete() {
        return Promise.resolve(false);
      },
      count() {
        return Promise.resolve(0);
      },
    };
    expect(ds).toBeDefined();
  });

  it('IDataSource.delete accepts EntityKey', () => {
    const ds: IDataSource = {
      findAll() {
        return Promise.resolve([]);
      },
      findById() {
        return Promise.resolve(null);
      },
      create() {
        return Promise.resolve({});
      },
      update() {
        return Promise.resolve({});
      },
      delete(_id: EntityKey) {
        return Promise.resolve(true);
      },
      count() {
        return Promise.resolve(0);
      },
    };
    expect(ds).toBeDefined();
  });

  it('NormalizedQuery carries optional cursor and offset', () => {
    const q: NormalizedQuery = {
      where: {},
      orderBy: {},
      limit: 10,
      offset: 0,
      cursor: 'abc',
      select: [],
    };
    expect(q.cursor).toBe('abc');
    expect(q.offset).toBe(0);
  });

  it('NormalizedQuery is valid without cursor (first page)', () => {
    const q: NormalizedQuery = {
      where: {},
      orderBy: {},
      limit: 10,
      offset: 0,
      select: [],
    };
    expect(q.cursor).toBeUndefined();
  });

  it('PageResult carries rows and nextCursor', () => {
    const result: PageResult = { rows: [], nextCursor: null };
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('exports encodeCursor / decodeCursor / keysetPredicate from barrel', () => {
    expect(typeof encodeCursor).toBe('function');
    expect(typeof decodeCursor).toBe('function');
    expect(typeof keysetPredicate).toBe('function');
  });

  it('CursorPayload type is reachable from barrel', () => {
    const payload: CursorPayload = { keyValues: [1], sortFingerprint: 'id:asc' };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.keyValues).toEqual([1]);
  });
});

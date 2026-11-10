/**
 * The three validators: declared collections, filters and records. Each refusal
 * is asserted by its error class and message, and every accepted value comes
 * back as a fresh copy the caller can no longer change.
 */
import { describe, expect, it } from 'vitest';
import {
  VectorDimensionError,
  VectorFilterError,
  VectorRecordError,
  VectorScopeInvalidError,
} from '@setu-ts/common';
import type { VectorFieldType } from '@setu-ts/common';
import { resolveCollections } from '../../src/services/collection-spec.ts';
import { validateFilter } from '../../src/services/filter-validation.ts';
import {
  validateIds,
  validateRecords,
  validateScope,
  validateVector,
} from '../../src/services/record-validation.ts';

const FIELDS: ReadonlyMap<string, VectorFieldType> = new Map([
  ['tag', 'string'],
  ['year', 'number'],
  ['public', 'boolean'],
]);

describe('resolveCollections', () => {
  it('freezes a copy of each declared collection', () => {
    const filterable: Record<string, VectorFieldType> = { tag: 'string' };
    const resolved = resolveCollections([{ name: 'documents', dimensions: 3, filterable }]);
    const documents = resolved.get('documents')!;
    expect(documents.spec).toEqual({
      name: 'documents',
      dimensions: 3,
      filterable: { tag: 'string' },
    });
    expect(Object.isFrozen(documents.spec)).toBe(true);
    expect(Object.isFrozen(documents.spec.filterable)).toBe(true);
    filterable['year'] = 'number';
    expect(documents.fields.has('year')).toBe(false);
    expect(resolveCollections([{ name: 'plain', dimensions: 1 }]).get('plain')!.fields.size).toBe(
      0,
    );
  });

  it.each([
    [undefined, 'non-empty array'],
    [[], 'non-empty array'],
    [[null], 'must be an object'],
    [[{ name: 'Documents', dimensions: 3 }], 'collection name'],
    [[{ name: 'a'.repeat(41), dimensions: 3 }], 'collection name'],
    [[{ name: 'docs', dimensions: 0 }], 'dimensions'],
    [[{ name: 'docs', dimensions: 1.5 }], 'dimensions'],
    [[{ name: 'docs', dimensions: 4097 }], 'dimensions'],
    [[{ name: 'docs', dimensions: '3' }], 'dimensions'],
    [[{ name: 'docs', dimensions: 3, filterable: [] }], 'filterable must be an object'],
    [[{ name: 'docs', dimensions: 3, filterable: null }], 'filterable must be an object'],
    [[{ name: 'docs', dimensions: 3, filterable: { 'a.b': 'string' } }], 'must match'],
    [[{ name: 'docs', dimensions: 3, filterable: { $tag: 'string' } }], 'must match'],
    [[{ name: 'docs', dimensions: 3, filterable: { scope: 'string' } }], 'must match'],
    [[{ name: 'docs', dimensions: 3, filterable: { content: 'string' } }], 'must match'],
    [[{ name: 'docs', dimensions: 3, filterable: { tag: 'date' } }], 'type must be'],
    [
      [
        { name: 'docs', dimensions: 3 },
        { name: 'docs', dimensions: 4 },
      ],
      'declared twice',
    ],
  ])('refuses %j (%s)', (collections, message) => {
    expect(() => resolveCollections(collections)).toThrow(message);
  });

  it('caps filterable fields at 10', () => {
    const filterable = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}`, 'string']),
    );
    expect(() => resolveCollections([{ name: 'docs', dimensions: 3, filterable }])).toThrow(
      'more than 10 filterable fields',
    );
  });
});

describe('validateFilter', () => {
  it('returns a frozen copy of a valid filter', () => {
    const input = {
      and: [
        { field: 'tag', op: 'in', value: ['a', 'b'] },
        { field: 'year', op: 'gte', value: 2020 },
        { field: 'public', op: 'eq', value: true },
      ],
    };
    const copy = validateFilter(input, FIELDS);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(Object.isFrozen(copy)).toBe(true);
    (input.and[0]!.value as string[]).push('c');
    expect(copy).not.toEqual(input);
  });

  it.each([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [{ field: 'secret', op: 'eq', value: 'x' }, "'secret' is not declared"],
    [{ field: 'tag', op: 'eq', value: 'x', extra: 1 }, "exactly 'field', 'op' and 'value'"],
    [{ field: 'tag', op: 'eq' }, "exactly 'field', 'op' and 'value'"],
    [{ field: 'tag', op: 'contains', value: 'x' }, "unsupported operator 'contains'"],
    [{ field: 'tag', op: 'eq', value: '' }, 'non-empty string'],
    [{ field: 'tag', op: 'eq', value: 'x'.repeat(65) }, 'at most 64 UTF-8 bytes'],
    [{ field: 'tag', op: 'eq', value: '\uD800' }, 'non-empty string'],
    [{ field: 'tag', op: 'eq', value: 7 }, 'non-empty string'],
    [{ field: 'year', op: 'eq', value: Number.NaN }, 'finite number'],
    [{ field: 'year', op: 'lt', value: Number.POSITIVE_INFINITY }, 'finite number'],
    [{ field: 'public', op: 'eq', value: 'true' }, 'boolean'],
    [{ field: 'public', op: 'in', value: [true] }, "use 'eq', not 'in'"],
    [{ field: 'tag', op: 'in', value: [] }, '1 to 100 values'],
    [{ field: 'tag', op: 'in', value: 'a' }, '1 to 100 values'],
    [{ field: 'tag', op: 'in', value: Array.from({ length: 101 }, (_, i) => `v${i}`) }, '1 to 100'],
    [{ field: 'year', op: 'in', value: [1, Number.NaN] }, 'finite number'],
    [{ field: 'tag', op: 'gt', value: 1 }, "'gt' needs a number field"],
    [{ and: [] }, 'at least one clause'],
    [{ and: { field: 'tag', op: 'eq', value: 'x' } }, 'at least one clause'],
    [{ and: [{ field: 'tag', op: 'eq', value: 'x' }], field: 'tag' }, 'no other keys'],
  ])('refuses %j (%s)', (filter, message) => {
    expect(() => validateFilter(filter, FIELDS)).toThrow(VectorFilterError);
    expect(() => validateFilter(filter, FIELDS)).toThrow(message);
  });

  it('refuses nesting deeper than 4 and more than 32 clauses', () => {
    let deep: unknown = { field: 'tag', op: 'eq', value: 'x' };
    for (let i = 0; i < 5; i++) deep = { and: [deep] };
    expect(() => validateFilter(deep, FIELDS)).toThrow('nests deeper than 4');
    const wide = {
      and: Array.from({ length: 32 }, () => ({ field: 'tag', op: 'eq', value: 'x' })),
    };
    expect(() => validateFilter(wide, FIELDS)).toThrow('more than 32 clauses');
  });

  it('does not read a field inherited through the prototype', () => {
    const inherited = Object.create({ field: 'tag', op: 'eq', value: 'x' }) as object;
    expect(() => validateFilter(inherited, FIELDS)).toThrow("exactly 'field', 'op' and 'value'");
  });

  it('validates the same in-list it returns, read once (audit F6)', () => {
    let reads = 0;
    const shifting = new Proxy(['a'], {
      get(target, key, receiver) {
        // A second pass over the list sees an over-long value.
        if (key === '0' && reads++ > 0) return 'x'.repeat(5000);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const out = validateFilter({ field: 'tag', op: 'in', value: shifting }, FIELDS) as {
      value: readonly string[];
    };
    expect(out.value).toEqual(['a']);
  });

  it('bounds caller names quoted in refusals and survives a throwing toString (audit F7)', () => {
    const long = 'f'.repeat(10_000);
    let message = '';
    try {
      validateFilter({ field: long, op: 'eq', value: 'x' }, FIELDS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('is not declared filterable');
    expect(message.length).toBeLessThan(200);
    const hostile = {
      toString(): string {
        throw new Error('boom');
      },
    };
    expect(() => validateFilter({ field: hostile, op: 'eq', value: 'x' }, FIELDS)).toThrow(
      VectorFilterError,
    );
    expect(() => validateFilter({ field: null, op: 'eq', value: 'x' }, FIELDS)).toThrow(
      "filter field '<null>' is not declared",
    );
    expect(() => validateFilter({ field: 7, op: 'eq', value: 'x' }, FIELDS)).toThrow(
      "filter field '<number>' is not declared",
    );
    expect(() => validateFilter({ field: 'tag', op: hostile, value: 'x' }, FIELDS)).toThrow(
      VectorFilterError,
    );
    let recordMessage = '';
    try {
      validateRecords(
        [{ id: 'r', vector: [1, 0, 0], metadata: { [long]: 'x' } }],
        3,
        FIELDS,
        500,
        'upsert',
      );
    } catch (error) {
      recordMessage = (error as Error).message;
    }
    expect(recordMessage).toContain('is not declared filterable');
    expect(recordMessage.length).toBeLessThan(200);
  });
});

describe('record validation', () => {
  it('M139c accepts each operation boundary and names the refused cap', () => {
    const records = Array.from({ length: 5001 }, (_, i) => ({ id: `r${i}`, vector: [1, 0, 0] }));
    const cases = [
      [500, 'upsert', 'an upsert'],
      [5000, 'replaceSource', 'a replaceSource call'],
      // The refusal names the operation, not a label guessed from the number.
      [500, 'replaceSource', 'a replaceSource call'],
    ] as const;
    for (const [max, operation, named] of cases) {
      expect(validateRecords(records.slice(0, max), 3, FIELDS, max, operation)).toHaveLength(max);
      expect(() => validateRecords(records.slice(0, max + 1), 3, FIELDS, max, operation)).toThrow(
        `${named} takes at most ${max} records`,
      );
    }
  });
  it('accepts and copies a valid record', () => {
    const vector = [1, 0, 0];
    const [record] = validateRecords(
      [{ id: 'r1', vector, sourceId: 's1', content: 'text', metadata: { tag: 'a', year: 1 } }],
      3,
      FIELDS,
      500,
      'upsert',
    );
    expect(record).toEqual({
      id: 'r1',
      vector: [1, 0, 0],
      sourceId: 's1',
      content: 'text',
      metadata: { tag: 'a', year: 1 },
    });
    vector[0] = 9;
    expect(record!.vector[0]).toBe(1);
    expect(validateRecords([{ id: 'r2', vector: [0, 1, 0] }], 3, FIELDS, 500, 'upsert')[0]).toEqual(
      {
        id: 'r2',
        vector: [0, 1, 0],
        metadata: {},
      },
    );
  });

  it.each([
    ['not an array', 'x', 'at most 500 records'],
    [
      'too many',
      Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, vector: [1, 0, 0] })),
      'at most 500',
    ],
    ['a non-object record', [null], 'must be an object'],
    ['an empty id', [{ id: '', vector: [1, 0, 0] }], 'record id'],
    ['an over-long id', [{ id: 'x'.repeat(257), vector: [1, 0, 0] }], 'record id'],
    ['a bad source id', [{ id: 'r', vector: [1, 0, 0], sourceId: 3 }], 'source id'],
    ['non-string content', [{ id: 'r', vector: [1, 0, 0], content: 3 }], 'record content'],
    [
      'over-size content',
      [{ id: 'r', vector: [1, 0, 0], content: 'x'.repeat(8193) }],
      'record content',
    ],
    [
      'array metadata',
      [{ id: 'r', vector: [1, 0, 0], metadata: [] }],
      'metadata must be an object',
    ],
    [
      'an undeclared key',
      [{ id: 'r', vector: [1, 0, 0], metadata: { other: 'x' } }],
      "'other' is not declared",
    ],
    [
      'a constructor key',
      [{ id: 'r', vector: [1, 0, 0], metadata: { constructor: 'x' } }],
      "'constructor' is not declared",
    ],
    [
      'a mistyped string',
      [{ id: 'r', vector: [1, 0, 0], metadata: { tag: 1 } }],
      'non-empty string',
    ],
    [
      'a NaN number',
      [{ id: 'r', vector: [1, 0, 0], metadata: { year: Number.NaN } }],
      'finite number',
    ],
    [
      'a repeated id',
      [
        { id: 'r', vector: [1, 0, 0] },
        { id: 'r', vector: [0, 1, 0] },
      ],
      'same record id twice',
    ],
    ['a string boolean', [{ id: 'r', vector: [1, 0, 0], metadata: { public: 'yes' } }], 'boolean'],
  ])('refuses %s', (_label, records, message) => {
    expect(() => validateRecords(records, 3, FIELDS, 500, 'upsert')).toThrow(VectorRecordError);
    expect(() => validateRecords(records, 3, FIELDS, 500, 'upsert')).toThrow(message);
  });

  it('reads only own properties of a record', () => {
    const inherited = Object.assign(Object.create({ metadata: { other: 'x' } }) as object, {
      id: 'r',
      vector: [1, 0, 0],
    });
    expect(validateRecords([inherited], 3, FIELDS, 500, 'upsert')[0]!.metadata).toEqual({});
  });

  it.each([
    [[1, 0], 'exactly 3 components'],
    ['abc', 'exactly 3 components'],
    [[1, Number.NaN, 0], 'finite number'],
    [[1, Number.POSITIVE_INFINITY, 0], 'finite number'],
    [[1, '0', 0], 'finite number'],
    [[0, 0, 0], 'all zeros'],
    [[-0, 0, 0], 'all zeros'],
    // Finite as a double but infinite once stored as float32 (pgvector, Qdrant, Vectorize).
    [[1e39, 0, 0], 'float32'],
    [[-3.5e38, 0, 0], 'float32'],
    // Non-zero as a double, all zeros once rounded to float32.
    [[1e-46, 0, 0], 'all zeros'],
    // The squared norm, accumulated in float32 as the backends do (audit F5).
    [[1e30, 0, 0], 'float32 norm'],
    [[1e-30, 0, 0], 'all zeros'],
  ])('refuses vector %j', (vector, message) => {
    expect(() => validateVector(vector, 3)).toThrow(VectorDimensionError);
    expect(() => validateVector(vector, 3)).toThrow(message);
  });

  it('accepts the largest and smallest vectors whose float32 norm is finite and non-zero', () => {
    expect(validateVector([1e19, 0, 0], 3)).toEqual([1e19, 0, 0]);
    expect(validateVector([1e-19, 0, 0], 3)).toEqual([1e-19, 0, 0]);
  });

  it('validates scopes and id lists', () => {
    expect(validateScope('tenant-a')).toBe('tenant-a');
    for (const scope of ['', 'x'.repeat(65), '\uDC00', 3, undefined]) {
      expect(() => validateScope(scope)).toThrow(VectorScopeInvalidError);
    }
    expect(validateIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => validateIds('a')).toThrow('at most 1000 ids');
    expect(() => validateIds(Array.from({ length: 1001 }, (_, i) => `r${i}`))).toThrow(
      'at most 1000',
    );
    expect(() => validateIds([''])).toThrow('record id');
  });
});

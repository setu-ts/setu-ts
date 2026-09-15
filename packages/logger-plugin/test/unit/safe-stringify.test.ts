import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { safeStringify } from '../../src/loggers/safe-stringify.ts';

describe('safeStringify', () => {
  describe('ordinary values', () => {
    it('serializes a plain record unchanged', () => {
      expect(safeStringify({ a: 1, b: 'two', c: null })).toBe('{"a":1,"b":"two","c":null}');
    });

    it('serializes nested objects and arrays unchanged', () => {
      expect(safeStringify({ a: { b: [1, { c: 2 }] } })).toBe('{"a":{"b":[1,{"c":2}]}}');
    });
  });

  describe('circular structures', () => {
    it('replaces a self-reference with the same token pino emits', () => {
      const cyclic: Record<string, unknown> = { t: 1 };
      cyclic.self = cyclic;
      expect(safeStringify({ r: cyclic })).toBe('{"r":{"t":1,"self":"[Circular]"}}');
    });

    it('replaces a cycle closed further up the chain', () => {
      const root: { deep: { back: unknown } } = { deep: { back: null } };
      root.deep.back = root;
      expect(safeStringify(root)).toBe('{"deep":{"back":"[Circular]"}}');
    });

    it('replaces a cycle through an array', () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(safeStringify({ arr })).toBe('{"arr":[1,2,"[Circular]"]}');
    });

    // The whole correctness of the ancestor walk. A WeakSet of every object
    // already seen reports the SECOND appearance of a shared object as
    // circular, dropping a field the caller supplied — pino renders both, and
    // so must this.
    it('renders a shared object twice — a repeat is not a cycle', () => {
      const shared = { a: 1 };
      expect(safeStringify({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    });

    it('renders a shared object repeated inside an array', () => {
      const shared = { a: 1 };
      expect(safeStringify({ list: [shared, shared] })).toBe('{"list":[{"a":1},{"a":1}]}');
    });

    it('renders equal-but-distinct siblings in full', () => {
      expect(safeStringify({ a: { n: 1 }, b: { n: 1 } })).toBe('{"a":{"n":1},"b":{"n":1}}');
    });
  });

  describe('bigint', () => {
    it('renders a bigint as its decimal string', () => {
      expect(safeStringify({ v: 10n })).toBe('{"v":"10"}');
    });

    // Quoted rather than pino's unquoted digits: the quoted form survives a
    // consumer's JSON.parse, where unquoted digits land in a JS number and
    // silently lose precision above MAX_SAFE_INTEGER.
    it('preserves a bigint beyond MAX_SAFE_INTEGER exactly', () => {
      const big = 9007199254740993n;
      const text = safeStringify({ v: big })!;
      expect(text).toBe('{"v":"9007199254740993"}');
      expect(JSON.parse(text).v).toBe(big.toString());
    });

    it('renders a bigint nested inside an object', () => {
      expect(safeStringify({ a: { v: 1n } })).toBe('{"a":{"v":"1"}}');
    });
  });

  describe('values that throw while being read', () => {
    it('reports failure rather than throwing for a throwing toJSON', () => {
      const hostile = {
        toJSON(): never {
          throw new Error('boom');
        },
      };
      expect(safeStringify({ r: hostile })).toBeUndefined();
    });

    it('reports failure rather than throwing for a throwing getter', () => {
      const hostile = {
        get x(): never {
          throw new Error('boom');
        },
      };
      expect(safeStringify({ r: hostile })).toBeUndefined();
    });
  });
});

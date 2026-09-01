/**
 * Coverage for the DynamoDB `AttributeValue` ⇄ JS marshalling
 * (`dynamo-marshal.ts`): round trip per type, nested `M`/`L` recursion, the
 * lossy-`N` fidelity rule (§3.15) with a control proving the naive `Number()`
 * path differs, the declared date encodings (§3.14), and the refusals for
 * values DynamoDB cannot represent losslessly.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as dynamoMarshal from '../../src/adapters/dynamo/dynamo-marshal.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

const {
  marshalDynamoValue,
  marshalDynamoItem,
  unmarshalDynamoValue,
  unmarshalDynamoItem,
} = dynamoMarshal;

/** §1A N1's measured value: 38 decimal digits, lossy through `Number()`. */
const LOSSY_N = '99999999999999999999999999999999999999';

describe('marshalDynamoValue — scalars', () => {
  it('marshals a string to S', () => {
    expect(marshalDynamoValue('widget')).toStrictEqual({ S: 'widget' });
  });

  it('marshals a finite number to its exact decimal string in N', () => {
    expect(marshalDynamoValue(42)).toStrictEqual({ N: '42' });
    expect(marshalDynamoValue(-3.5)).toStrictEqual({ N: '-3.5' });
    expect(marshalDynamoValue(0.1)).toStrictEqual({ N: '0.1' });
  });

  it('marshals booleans to BOOL, preserving false', () => {
    expect(marshalDynamoValue(true)).toStrictEqual({ BOOL: true });
    expect(marshalDynamoValue(false)).toStrictEqual({ BOOL: false });
  });

  it('marshals null to NULL', () => {
    expect(marshalDynamoValue(null)).toStrictEqual({ NULL: true });
  });

  it('marshals a Uint8Array to B, carrying the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const marshalled = marshalDynamoValue(bytes);
    expect(marshalled.B).toBeDefined();
    expect(marshalled.B).toStrictEqual(bytes);
  });
});

describe('marshalDynamoValue — declared date encodings', () => {
  it("marshals a Date under 'iso' to the exact ISO-8601 string in S", () => {
    const date = new Date('2024-06-01T12:34:56.789Z');
    expect(marshalDynamoValue(date, 'iso')).toStrictEqual({
      S: '2024-06-01T12:34:56.789Z',
    });
  });

  it("marshals a Date under 'epochMs' to epoch milliseconds in N", () => {
    const date = new Date('2024-06-01T12:34:56.789Z');
    expect(marshalDynamoValue(date, 'epochMs')).toStrictEqual({
      N: String(date.getTime()),
    });
  });

  it('refuses a Date with no declared encoding, naming the option', () => {
    // §3.14: DynamoDB has no date type, so the adapter cannot know how the
    // stored value is encoded — it refuses rather than guessing.
    const refusal = (() => {
      try {
        marshalDynamoValue(new Date('2024-06-01T12:34:56.789Z'));
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    const err = refusal as UnsupportedQueryFeatureError;
    expect(err.feature).toBe('date-encoding');
    expect(err.adapter).toBe('dynamodb');
    expect(err.message).toContain('dateAttributes');
  });
});

describe('marshalDynamoValue — composites', () => {
  it('marshals a plain object to M with each member marshalled', () => {
    expect(
      marshalDynamoValue({ name: 'ada', count: 2, active: true, note: null }),
    ).toStrictEqual({
      M: {
        name: { S: 'ada' },
        count: { N: '2' },
        active: { BOOL: true },
        note: { NULL: true },
      },
    });
  });

  it('marshals an array to L with each element marshalled', () => {
    expect(marshalDynamoValue(['a', 1, false])).toStrictEqual({
      L: [{ S: 'a' }, { N: '1' }, { BOOL: false }],
    });
  });

  it('marshals nested composites recursively', () => {
    const marshalled = marshalDynamoValue({
      orders: [{ id: 'o1', tags: ['vip', null] }],
    });
    expect(marshalled).toStrictEqual({
      M: {
        orders: {
          L: [
            {
              M: {
                id: { S: 'o1' },
                tags: { L: [{ S: 'vip' }, { NULL: true }] },
              },
            },
          ],
        },
      },
    });
  });

  it('marshals an empty object and an empty array', () => {
    expect(marshalDynamoValue({})).toStrictEqual({ M: {} });
    expect(marshalDynamoValue([])).toStrictEqual({ L: [] });
  });

  it('marshals a null-prototype record exactly like a plain object', () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.id = 'r1';
    expect(marshalDynamoValue(record)).toStrictEqual({ M: { id: { S: 'r1' } } });
  });
});

describe('marshalDynamoValue — refusals for unrepresentable values', () => {
  const refuse = (value: unknown, dateEncoding?: 'iso' | 'epochMs'): Error => {
    try {
      marshalDynamoValue(value, dateEncoding);
      throw new Error('expected marshalDynamoValue to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedQueryFeatureError);
      return error as Error;
    }
  };

  it('refuses undefined', () => {
    const err = refuse(undefined);
    expect(err.message).toContain('undefined');
    expect(err.message).not.toContain('secret');
  });

  it('refuses NaN and Infinity — N is a decimal, not a float', () => {
    expect(refuse(Number.NaN).message).toContain('finite decimal');
    expect(refuse(Number.POSITIVE_INFINITY).message).toContain('finite decimal');
  });

  it('refuses a bigint by type name', () => {
    const err = refuse(9007199254740993n);
    expect(err.message).toContain("'bigint'");
  });

  it('refuses a function by type name', () => {
    expect(refuse(() => 1).message).toContain("'function'");
  });

  it('refuses a symbol by type name', () => {
    expect(refuse(Symbol('tag')).message).toContain("'symbol'");
  });

  it('refuses a non-Uint8Array typed-array view by constructor name', () => {
    expect(refuse(new Int8Array([1, 2])).message).toContain('Int8Array');
  });

  it('refuses a Map instead of silently marshalling an empty M', () => {
    const map = new Map([['a', 1]]);
    expect(refuse(map).message).toContain("'Map'");
  });

  it('refuses an undefined element inside a list, naming the index', () => {
    const err = refuse(['a', undefined, 'b']);
    expect(err.message).toContain('[1]');
  });

  it('refuses a Date nested inside an object even when the parent is declared', () => {
    // The declared encoding belongs to the attribute itself; a nested Date
    // has no declaration of its own, so it is refused rather than guessed.
    const err = refuse({ meta: { created: new Date(0) } }, 'iso');
    expect(err.message).toContain("'meta.created'");
    expect(err.message).toContain('dateAttributes');
  });
});

describe('unmarshalDynamoValue — scalars', () => {
  it('unmarshals S to a string', () => {
    expect(unmarshalDynamoValue({ S: 'widget' })).toBe('widget');
  });

  it('unmarshals an exact N to a number', () => {
    expect(unmarshalDynamoValue({ N: '42' })).toBe(42);
    expect(unmarshalDynamoValue({ N: '-3.5' })).toBe(-3.5);
    expect(unmarshalDynamoValue({ N: '0.1' })).toBe(0.1);
    expect(unmarshalDynamoValue({ N: '1e+38' })).toBe(1e38);
  });

  it('unmarshals BOOL preserving false — never a truthiness read', () => {
    expect(unmarshalDynamoValue({ BOOL: false })).toBe(false);
    expect(unmarshalDynamoValue({ BOOL: true })).toBe(true);
  });

  it('unmarshals NULL to null', () => {
    expect(unmarshalDynamoValue({ NULL: true })).toBe(null);
  });

  it('unmarshals B to the same bytes', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    expect(unmarshalDynamoValue({ B: bytes })).toStrictEqual(bytes);
  });

  it('unmarshals SS, NS and BS to arrays, NS reusing the exactness rule', () => {
    expect(unmarshalDynamoValue({ SS: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(unmarshalDynamoValue({ NS: ['1', LOSSY_N] })).toEqual([1, LOSSY_N]);
    const binary = new Uint8Array([1]);
    expect(unmarshalDynamoValue({ BS: [binary] })).toEqual([binary]);
  });

  it('refuses an AttributeValue with no type member instead of yielding undefined', () => {
    expect(() => unmarshalDynamoValue({})).toThrow(UnsupportedQueryFeatureError);
  });
});

describe('unmarshalDynamoValue — the lossy-N fidelity rule (§3.15)', () => {
  it('preserves a 38-digit decimal as its string', () => {
    expect(unmarshalDynamoValue({ N: LOSSY_N })).toBe(LOSSY_N);
    expect(typeof unmarshalDynamoValue({ N: LOSSY_N })).toBe('string');
  });

  it('control: the naive Number() path WOULD differ — 1e+38', () => {
    // The guard is what preserves the datum: without it, the value read back
    // would be 1e+38, which is a different value from the stored decimal.
    const naive = Number(LOSSY_N);
    expect(String(naive)).toBe('1e+38');
    expect(String(naive)).not.toBe(LOSSY_N);
    expect(naive).not.toBe(LOSSY_N as unknown as number);
  });

  it('preserves a non-canonical decimal whose round trip is not exact', () => {
    // '007' converts to 7, and String(7) !== '007' — so the original is kept.
    expect(unmarshalDynamoValue({ N: '007' })).toBe('007');
  });

  it('the exactness test is on the round trip, not on magnitude', () => {
    // A small value with a non-canonical form is preserved too.
    expect(unmarshalDynamoValue({ N: '1.50' })).toBe('1.50');
  });
});

describe('unmarshalDynamoValue — composites', () => {
  it('unmarshals M recursively', () => {
    expect(
      unmarshalDynamoValue({
        M: {
          name: { S: 'ada' },
          address: { M: { city: { S: 'Oslo' } } },
          tags: { L: [{ S: 'vip' }, { NULL: true }] },
        },
      }),
    ).toStrictEqual({
      name: 'ada',
      address: { city: 'Oslo' },
      tags: ['vip', null],
    });
  });

  it('unmarshals L recursively, including nested N fidelity', () => {
    expect(
      unmarshalDynamoValue({ L: [{ N: '2' }, { M: { total: { N: LOSSY_N } } }] }),
    ).toStrictEqual([2, { total: LOSSY_N }]);
  });
});

describe('unmarshalDynamoItem', () => {
  it('unmarshals every attribute of an item into a row', () => {
    expect(
      unmarshalDynamoItem({
        id: { S: 'u1' },
        age: { N: '30' },
        active: { BOOL: false },
        deleted: { NULL: true },
        avatar: { B: new Uint8Array([1]) },
        profile: { M: { city: { S: 'Oslo' } } },
        orders: { L: [{ S: 'o1' }] },
      }),
    ).toStrictEqual({
      id: 'u1',
      age: 30,
      active: false,
      deleted: null,
      avatar: new Uint8Array([1]),
      profile: { city: 'Oslo' },
      orders: ['o1'],
    });
  });

  it('returns a mutable row a caller may extend', () => {
    const row = unmarshalDynamoItem({ id: { S: 'u1' } });
    row.extra = 'ok';
    expect(row.extra).toBe('ok');
  });
});

describe('marshalDynamoItem', () => {
  it('marshals a whole row, one AttributeValue per attribute', () => {
    expect(
      marshalDynamoItem({
        id: 'u1',
        age: 30,
        active: false,
        note: null,
        avatar: new Uint8Array([1]),
        profile: { city: 'Oslo' },
        orders: ['o1'],
      }),
    ).toStrictEqual({
      id: { S: 'u1' },
      age: { N: '30' },
      active: { BOOL: false },
      note: { NULL: true },
      avatar: { B: new Uint8Array([1]) },
      profile: { M: { city: { S: 'Oslo' } } },
      orders: { L: [{ S: 'o1' }] },
    });
  });

  it('omits an undefined attribute instead of storing a placeholder', () => {
    const item = marshalDynamoItem({ id: 'u1', nickname: undefined });
    expect(Object.hasOwn(item, 'nickname')).toBe(false);
    expect(item).toStrictEqual({ id: { S: 'u1' } });
  });

  it('omits an undefined member inside a nested map', () => {
    expect(marshalDynamoItem({ id: 'u1', meta: { a: 1, b: undefined } }))
      .toStrictEqual({ id: { S: 'u1' }, meta: { M: { a: { N: '1' } } } });
  });

  it('marshals an empty row to an empty item', () => {
    expect(marshalDynamoItem({})).toStrictEqual({});
  });

  it("threads each attribute's declared date encoding", () => {
    const iso = new Date('2024-06-01T12:34:56.789Z');
    const epoch = new Date('2024-06-02T00:00:00.000Z');
    expect(
      marshalDynamoItem(
        { pk: 'o1', createdAt: iso, updatedAt: epoch },
        { createdAt: 'iso', updatedAt: 'epochMs' },
      ),
    ).toStrictEqual({
      pk: { S: 'o1' },
      createdAt: { S: '2024-06-01T12:34:56.789Z' },
      updatedAt: { N: String(epoch.getTime()) },
    });
  });

  it('refuses an undeclared Date attribute, naming the attribute', () => {
    try {
      marshalDynamoItem(
        { pk: 'o1', createdAt: new Date(0) },
        { updatedAt: 'iso' },
      );
      throw new Error('expected marshalDynamoItem to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedQueryFeatureError);
      expect((error as UnsupportedQueryFeatureError).feature).toBe(
        'date-encoding',
      );
      expect((error as Error).message).toContain("'createdAt'");
    }
  });

  it('leaves a declared attribute whose value is already a string on S', () => {
    // A caller that pre-encodes its dates stores what it gave: the
    // declaration only decides how a Date value is converted.
    expect(
      marshalDynamoItem({ pk: 'o1', createdAt: '2024-06-01' }, { createdAt: 'iso' }),
    ).toStrictEqual({ pk: { S: 'o1' }, createdAt: { S: '2024-06-01' } });
  });
});

describe('round trips (marshal → unmarshal is identity per type)', () => {
  const roundTrips = (
    value: unknown,
    dateEncoding?: 'iso' | 'epochMs',
  ): unknown => unmarshalDynamoValue(marshalDynamoValue(value, dateEncoding));

  it('identity per scalar type', () => {
    expect(roundTrips('widget')).toBe('widget');
    expect(roundTrips(42)).toBe(42);
    expect(roundTrips(-3.5)).toBe(-3.5);
    expect(roundTrips(0.1)).toBe(0.1);
    expect(roundTrips(true)).toBe(true);
    expect(roundTrips(false)).toBe(false);
    expect(roundTrips(null)).toBe(null);
    expect(roundTrips(new Uint8Array([4, 5, 6]))).toStrictEqual(
      new Uint8Array([4, 5, 6]),
    );
  });

  it('identity for nested objects and arrays, recursively', () => {
    const deep = {
      id: 'u1',
      count: 7,
      ok: true,
      missing: null,
      profile: { city: 'Oslo', codes: [1, 2.5] },
      orders: [{ id: 'o1', tags: ['vip', null] }, { id: 'o2' }],
    };
    expect(roundTrips(deep)).toStrictEqual(deep);
  });

  it('a JS number that stringifies to exponent form round-trips exactly', () => {
    expect(roundTrips(1e38)).toBe(1e38);
  });

  it('an exact stored N becomes a number; a lossy stored N stays a string', () => {
    expect(unmarshalDynamoItem({ exact: { N: '42' }, lossy: { N: LOSSY_N } }))
      .toStrictEqual({ exact: 42, lossy: LOSSY_N });
  });
});

describe('DynamoDB marshalling hardening (Qodo review)', () => {
  it('refuses an invalid Date by name under either declared encoding', () => {
    // Unguarded, `iso` threw a bare `RangeError: Invalid time value` naming no
    // attribute and `epochMs` emitted `{ N: 'NaN' }`, which DynamoDB rejects
    // later with a message naming neither the entity nor the attribute.
    for (const encoding of ['iso', 'epochMs'] as const) {
      expect(() => marshalDynamoValue(new Date('nonsense'), encoding)).toThrow(
        /Date .*is invalid/,
      );
    }
    expect(() => marshalDynamoValue(new Date('2026-01-01T00:00:00.000Z'), 'iso')).not.toThrow();
  });

  it('keeps a `__proto__` attribute as an own property on both read and write', () => {
    // DynamoDB accepts and returns an attribute literally named `__proto__`
    // (measured). A plain `obj[key] = value` for that key is runtime-dependent:
    // on Node it invokes the prototype setter — dropping the attribute and
    // replacing the object's prototype — while on Deno it creates an own key,
    // so no test running here can observe the pollution directly. These
    // assertions pin the property the fix guarantees on every runtime.
    const item = JSON.parse('{"pk":{"S":"p"},"__proto__":{"M":{"admin":{"BOOL":true}}}}');
    const row = unmarshalDynamoItem(item);
    expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);

    const source = JSON.parse('{"pk":"p","__proto__":{"admin":true}}');
    const marshalled = marshalDynamoItem(source);
    expect(Object.prototype.hasOwnProperty.call(marshalled, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(marshalled)).toBe(Object.prototype);
  });
});

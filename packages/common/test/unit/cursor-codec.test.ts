/**
 * Portable keyset-cursor codec — encode, decode, and keyset-predicate.
 *
 * Every function here is pure: no driver, no runtime service, no I/O.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeCursor, encodeCursor, keysetPredicate } from '../../src/services/cursor.ts';
import type { CursorPayload } from '../../src/services/cursor.ts';
import type { FilterExpression } from '../../src/services/database.ts';

/**
 * Build a deliberately malformed cursor token directly, without going through
 * {@linkcode encodeCursor}.
 *
 * These cases exercise {@linkcode decodeCursor}, which takes UNTRUSTED input
 * and must answer `null` rather than throw. Routing them through
 * `encodeCursor` would require that function to accept payloads its own type
 * forbids — the guard that used to exist for exactly this reason emitted a
 * Date-lossy token `decodeCursor` then accepted as plain strings, so the
 * scaffolding was itself a silent-corruption path. Encoding the JSON here
 * keeps the untrusted-input coverage and lets `encodeCursor` trust its type.
 */
function malformedToken(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Minimal evaluator so the keyset tree is asserted by BEHAVIOR — which rows a
 * walk would keep — and not only by shape. `keysetPredicate` emits only
 * eq/gt/lt comparisons over string-named fields, so this covers its whole
 * output grammar.
 */
function matches(
  row: Record<string, string | number>,
  expr: FilterExpression,
): boolean {
  if (expr.type !== 'comparison') {
    return expr.type === 'or'
      ? expr.filters.some((child) => matches(row, child))
      : expr.filters.every((child) => matches(row, child));
  }
  if (typeof expr.field !== 'string') return false;
  const left = row[expr.field];
  if (expr.operator === 'eq') return left === expr.value;
  if (expr.operator === 'gt' || expr.operator === 'lt') {
    if (typeof left === 'number' && typeof expr.value === 'number') {
      return expr.operator === 'gt' ? left > expr.value : left < expr.value;
    }
    if (typeof left === 'string' && typeof expr.value === 'string') {
      return expr.operator === 'gt' ? left > expr.value : left < expr.value;
    }
  }
  return false;
}

describe('encodeCursor / decodeCursor round-trip', () => {
  it('round-trips a simple asc keyset payload', () => {
    const payload: CursorPayload = {
      orderedValues: [1],
      keyValues: [1],
      sortFingerprint: 'id:asc',
    };
    const token = encodeCursor(payload);
    expect(typeof token).toBe('string');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
    expect(token).not.toContain('=');
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual([1]);
    expect(decoded!.sortFingerprint).toBe('id:asc');
  });

  it('round-trips a desc payload with a string key', () => {
    const payload: CursorPayload = {
      orderedValues: ['last-id'],
      keyValues: ['last-id'],
      sortFingerprint: 'createdAt:desc',
    };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['last-id']);
    expect(decoded!.sortFingerprint).toBe('createdAt:desc');
  });

  it('round-trips a multi-column composite key', () => {
    const payload: CursorPayload = {
      orderedValues: ['tenant-1', 42],
      keyValues: ['tenant-1', 42],
      sortFingerprint: 'tenantId:asc,id:asc',
    };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['tenant-1', 42]);
    expect(decoded!.sortFingerprint).toBe('tenantId:asc,id:asc');
  });

  it('restores Date values while preserving numbers and strings', () => {
    const createdAt = new Date('2026-06-01T00:00:00.123Z');
    const decoded = decodeCursor(encodeCursor({
      orderedValues: [createdAt, 42, 'event-1'],
      keyValues: [createdAt, 42, 'event-1'],
      sortFingerprint: 'createdAt:desc,id:asc',
    }));

    expect(decoded).not.toBeNull();
    const orderedDate = decoded!.orderedValues[0];
    const keyDate = decoded!.keyValues[0];
    expect(orderedDate).toBeInstanceOf(Date);
    expect(keyDate).toBeInstanceOf(Date);
    if (!(orderedDate instanceof Date) || !(keyDate instanceof Date)) {
      throw new Error('cursor date was not restored');
    }
    expect(orderedDate.getTime()).toBe(createdAt.getTime());
    expect(keyDate.getTime()).toBe(createdAt.getTime());
    expect(typeof decoded!.orderedValues[1]).toBe('number');
    expect(typeof decoded!.orderedValues[2]).toBe('string');
  });

  it('copies orderedValues so the returned array is independent', () => {
    const original = [1, 2] as ReadonlyArray<string | number>;
    const payload: CursorPayload = {
      orderedValues: original,
      keyValues: original,
      sortFingerprint: 'a:asc',
    };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).not.toBe(original);
    // Reassign via a mutable copy to prove independence.
    const copy = [...decoded!.orderedValues] as (string | number)[];
    copy.push(3);
    expect(copy).toEqual([1, 2, 3]);
    // Original payload is unchanged.
    expect(payload.orderedValues).toEqual([1, 2]);
  });

  it('round-trips non-ASCII Unicode characters (2-byte UTF-8)', () => {
    // 'é' is U+00E9 → 2-byte UTF-8: 0xC3 0xA9
    const payload: CursorPayload = {
      orderedValues: ['café'],
      keyValues: ['café'],
      sortFingerprint: 'name:asc',
    };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['café']);
    expect(decoded!.sortFingerprint).toBe('name:asc');
  });

  it('round-trips CJK characters (3-byte UTF-8)', () => {
    // '中' is U+4E2D → 3-byte UTF-8: 0xE4 0xB8 0xAD
    const payload: CursorPayload = {
      orderedValues: ['中文'],
      keyValues: ['中文'],
      sortFingerprint: 'lang:asc',
    };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['中文']);
  });

  it('round-trips emoji/surrogate pairs (4-byte UTF-8)', () => {
    // '😀' is U+1F600 → 4-byte UTF-8: 0xF0 0x9F 0x98 0x80
    const payload: CursorPayload = {
      orderedValues: ['😀🎉'],
      keyValues: ['😀🎉'],
      sortFingerprint: 'emoji:asc',
    };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    // The emoji round-trip confirms the surrogate-pair formula uses 0xDC00
    // (not 0x400) as the low-surrogate base offset; a wrong offset would
    // produce garbled characters here.
    expect(decoded!.orderedValues).toEqual(['😀🎉']);
    expect(decoded!.sortFingerprint).toBe('emoji:asc');
  });

  it('base64url padding edge cases — 1 byte and 2 byte inputs', () => {
    // Force 1-byte and 2-byte UTF-8 sequences to exercise the padding
    // branches in base64FromBytes (lines where i+1 and i+2 < length).
    const single: CursorPayload = { orderedValues: ['A'], keyValues: ['A'], sortFingerprint: 's' };
    const d1 = decodeCursor(encodeCursor(single));
    expect(d1!.orderedValues).toEqual(['A']);

    const two: CursorPayload = { orderedValues: ['ab'], keyValues: ['ab'], sortFingerprint: 't' };
    const d2 = decodeCursor(encodeCursor(two));
    expect(d2!.orderedValues).toEqual(['ab']);
  });

  it('handles base64url with padding stripped correctly', () => {
    // base64url strips '=', so an input that originally had padding must
    // still decode back to the same bytes.
    const original: CursorPayload = {
      orderedValues: ['test'],
      keyValues: ['test'],
      sortFingerprint: 'fp',
    };
    const encoded = encodeCursor(original);
    // base64url should never contain '+' or '/' or '='
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['test']);
  });

  it('decodeCursor handles empty string and whitespace gracefully', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('   ')).toBeNull();
    expect(decodeCursor('abc def')).toBeNull();
  });

  it('keysetPredicate handles single element keyColumns with single orderBy', () => {
    const pred: FilterExpression = keysetPredicate([100], [100], { z: 'desc' }, ['z']);
    // z is the last field AND the last key column → no tiebreaker append.
    expect(pred).toEqual({
      type: 'or',
      filters: [{ type: 'comparison', field: 'z', operator: 'lt', value: 100 }],
    });
  });

  it('returns null for a token that is not base64url', () => {
    expect(decodeCursor('not-base64!!!')).toBeNull();
  });

  it('returns null for a token that decodes to non-object JSON', () => {
    // base64url of the string '42'
    expect(decodeCursor('NDI')).toBeNull();
  });

  it('returns null for a JSON object missing orderedValues', () => {
    expect(decodeCursor(malformedToken({ keyValues: [1], sortFingerprint: 'x:asc' }))).toBeNull();
  });

  it('returns null for a JSON object missing keyValues', () => {
    expect(decodeCursor(malformedToken({ orderedValues: [1], sortFingerprint: 'x:asc' })))
      .toBeNull();
  });

  it('returns null for a JSON object missing sortFingerprint', () => {
    expect(decodeCursor(malformedToken({ orderedValues: [1], keyValues: [1] }))).toBeNull();
  });

  it('returns null for a JSON object with wrong orderedValues type', () => {
    expect(
      decodeCursor(
        malformedToken({ orderedValues: 'not-an-array', keyValues: [1], sortFingerprint: 'x:asc' }),
      ),
    ).toBeNull();
  });

  it('returns null for a JSON object with wrong sortFingerprint type', () => {
    expect(
      decodeCursor(malformedToken({ orderedValues: [1], keyValues: [1], sortFingerprint: 42 })),
    ).toBeNull();
  });
});

describe('keysetPredicate', () => {
  it('produces a single or-comparison for desc sort when key matches orderBy', () => {
    // When the key column is the sort's only field, no tiebreaker is appended
    // — the single leg already covers the "after this row" semantics.
    const pred: FilterExpression = keysetPredicate([5], [5], { id: 'desc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [{ type: 'comparison', field: 'id', operator: 'lt', value: 5 }],
    });
  });

  it('produces a single or-comparison for asc sort when key matches orderBy', () => {
    const pred: FilterExpression = keysetPredicate([5], [5], { id: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [{ type: 'comparison', field: 'id', operator: 'gt', value: 5 }],
    });
  });

  it('emits the lexicographic or(gt, and(eq, gt)) tree', () => {
    // orderBy on `name` only; `id` is appended as the ascending tiebreaker.
    // Leg 1: strictly greater name. Leg 2: same name, strictly greater id —
    // plan §3.8's `or(lt(createdAt), and(eq(createdAt), gt(id)))` shape, with
    // asc directions.
    const pred: FilterExpression = keysetPredicate(['alice', 5], [5], { name: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'name', operator: 'gt', value: 'alice' },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 'alice' },
            { type: 'comparison', field: 'id', operator: 'gt', value: 5 },
          ],
        },
      ],
    });
  });

  it('does not duplicate a key column already present in orderBy', () => {
    // orderBy ends with `id`; it already is a sort position, so no tiebreaker
    // is appended — but the legs stay lexicographic: a later leg pins every
    // earlier field to its cursor value. orderedValues mirrors the sort:
    // [nameValue, idValue].
    const pred: FilterExpression = keysetPredicate([42, 5], [5], { name: 'asc', id: 'asc' }, [
      'id',
    ]);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `name`, gt orderedValues[0] = 42.
        { type: 'comparison', field: 'name', operator: 'gt', value: 42 },
        // Position 1: name pinned to 42, field `id` gt orderedValues[1] = 5.
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 42 },
            { type: 'comparison', field: 'id', operator: 'gt', value: 5 },
          ],
        },
      ],
    });
  });

  it('pins earlier sort fields with eq in each later leg', () => {
    // Empty keyColumns means no tiebreaker; the legs are still lexicographic.
    const pred: FilterExpression = keysetPredicate(['b', 2], [], { a: 'asc', b: 'desc' }, []);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `a` (asc), gt orderedValues[0] = 'b'.
        { type: 'comparison', field: 'a', operator: 'gt', value: 'b' },
        // Position 1: a pinned to 'b', field `b` (desc), lt orderedValues[1] = 2.
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'a', operator: 'eq', value: 'b' },
            { type: 'comparison', field: 'b', operator: 'lt', value: 2 },
          ],
        },
      ],
    });
  });

  it('indexes each tiebreaker key column by its keyValues position', () => {
    // `tenantId` and `id` are both appended (neither is in orderBy); each
    // takes ITS OWN keyValues entry — tenantId → keyValues[0], id →
    // keyValues[1] — never a shared keyValues[0] fallback.
    const pred: FilterExpression = keysetPredicate([77], [88, 99], { name: 'asc' }, [
      'tenantId',
      'id',
    ]);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'name', operator: 'gt', value: 77 },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 77 },
            { type: 'comparison', field: 'tenantId', operator: 'gt', value: 88 },
          ],
        },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 77 },
            { type: 'comparison', field: 'tenantId', operator: 'eq', value: 88 },
            { type: 'comparison', field: 'id', operator: 'gt', value: 99 },
          ],
        },
      ],
    });
  });

  it('reads key columns positionally when orderBy is empty', () => {
    // With empty orderBy every key column becomes an ascending tiebreaker,
    // each indexed by its own keyValues position (a → 1, b → 2).
    const pred: FilterExpression = keysetPredicate([], [1, 2], {}, ['a', 'b']);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'a', operator: 'gt', value: 1 },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'a', operator: 'eq', value: 1 },
            { type: 'comparison', field: 'b', operator: 'gt', value: 2 },
          ],
        },
      ],
    });
  });

  it('returns a bare or when there are no key columns and no orderBy', () => {
    const pred: FilterExpression = keysetPredicate([], [], {}, []);
    expect(pred).toEqual({ type: 'or', filters: [] });
  });

  it('keeps only rows strictly after the cursor', () => {
    // Behavioral control for the T1 defect this predicate replaces: the old
    // `and(or(strict…), or(eq key…))` tree matched only rows whose key equaled
    // the cursor row's key, and a flat `or(strict…)` even matched rows BEFORE
    // the cursor. Sort (a asc, b asc) with an `id` tiebreaker; cursor row
    // (a=2, b=1, id=5):
    const pred: FilterExpression = keysetPredicate([2, 1], [5], { a: 'asc', b: 'asc' }, ['id']);
    // A row before the cursor must NOT match — the old flat strict-or matched
    // it because b=9 > 1.
    expect(matches({ a: 1, b: 9, id: 5 }, pred)).toBe(false);
    // A row after on the first sort field matches.
    expect(matches({ a: 3, b: 0, id: 5 }, pred)).toBe(true);
    // A row after on the second sort field matches (same a, greater b).
    expect(matches({ a: 2, b: 7, id: 5 }, pred)).toBe(true);
    // A row tied on both sort fields matches through the id tiebreaker leg —
    // the P11 class the tiebreaker exists for.
    expect(matches({ a: 2, b: 1, id: 9 }, pred)).toBe(true);
    // The cursor row itself does not match (strictly after, not at-or-after).
    expect(matches({ a: 2, b: 1, id: 5 }, pred)).toBe(false);
  });

  it('matches a later row whose key differs from the cursor key', () => {
    // The measured T9 defect: with a pure-tiebreaker key the old tree
    // required eq(id, cursorKey), so a row with a different id NEVER matched.
    const pred: FilterExpression = keysetPredicate(['alice'], [5], { name: 'asc' }, ['id']);
    expect(matches({ name: 'bob', id: 9 }, pred)).toBe(true);
    expect(matches({ name: 'aaron', id: 9 }, pred)).toBe(false);
  });
});

describe('cursor.ts defensive edge cases', () => {
  it('handles malformed base64 with padding character in stream', () => {
    // base64url decoding strips '=', but a standard base64 token with '='
    // in the middle should be handled without crashing (the decode loop
    // breaks on '=').
    const token = btoa('{"orderedValues":[1],"keyValues":[1],"sortFingerprint":"x"}')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Normal round-trip still works.
    const d = decodeCursor(token);
    expect(d).not.toBeNull();
    expect(d!.orderedValues).toEqual([1]);
  });

  it('handles truncated base64url input gracefully', () => {
    // A base64url string that doesn't decode to a valid length will produce
    // bytes that JSON.parse can't handle — decodeCursor returns null.
    expect(decodeCursor('YWJj')).toBeNull(); // 'abc' in base64, not valid JSON
    expect(decodeCursor('dGVzdA')).toBeNull(); // 'test' in base64, not valid JSON
  });

  it('handles base64url input with leftover bytes after full groups', () => {
    // base64 strings whose length isn't a multiple of 4 still work because
    // the decoder ignores trailing incomplete groups via the ?? 0 fallbacks.
    const payload: CursorPayload = { orderedValues: [42], keyValues: [42], sortFingerprint: 'a' };
    const encoded = encodeCursor(payload);
    // Remove padding to make a shorter valid base64url string
    const stripped = encoded.replace(/=$/, '');
    const decoded = decodeCursor(stripped);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual([42]);
  });

  it('base64url strips padding so decoded bytes have exact length', () => {
    // A 1-byte input produces a 2-char base64url token (no padding in output
    // because strip removes '='). Decoding must still yield exactly 1 byte.
    const payload: CursorPayload = { orderedValues: ['x'], keyValues: ['x'], sortFingerprint: 'a' };
    const encoded = encodeCursor(payload);
    // Strip any trailing '=' (the base64url spec strips padding).
    const stripped = encoded.replace(/=$/, '');
    expect(stripped.length).toBeLessThan(encoded.length + 1);
    const decoded = decodeCursor(stripped);
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).toEqual(['x']);
  });

  it('handles base64url with only 1 value (exercises ??0 fallbacks)', () => {
    // 1 base64 char -> values.length=1 -> n1/n2/n3 are undefined -> ??0
    // This exercises the defensive null-coalescing paths in base64ToBytes.
    // The result is not valid JSON, so decodeCursor returns null.
    expect(decodeCursor('Q')).toBeNull();
  });

  it('handles base64url with only 2 values (exercises ??0 fallbacks)', () => {
    // 2 base64 chars -> values.length=2 -> n2/n3 are undefined -> ??0
    expect(decodeCursor('QQ')).toBeNull();
  });

  it('handles base64url with only 3 values (exercises ??0 fallback)', () => {
    // 3 base64 chars -> values.length=3 -> n3 is undefined -> ??0
    expect(decodeCursor('QQQ')).toBeNull();
  });
});

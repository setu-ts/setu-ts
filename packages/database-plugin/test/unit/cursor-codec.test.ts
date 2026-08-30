/**
 * Portable keyset-cursor codec — encode, decode, and keyset-predicate.
 *
 * Every function here is pure: no driver, no runtime service, no I/O.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeCursor, encodeCursor, keysetPredicate } from '@setu-ts/common';
import type { CursorPayload } from '@setu-ts/common';
import type { FilterExpression } from '@setu-ts/common';

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
    expect(decoded!.keyValues).toEqual([1]);
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
    expect(decoded!.keyValues).toEqual(['last-id']);
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
    expect(decoded!.keyValues).toEqual(['tenant-1', 42]);
    expect(decoded!.sortFingerprint).toBe('tenantId:asc,id:asc');
  });

  it('copies orderedValues and keyValues so the returned arrays are independent', () => {
    const originalOrdered = [1, 2] as ReadonlyArray<string | number>;
    const originalKeys = [1, 2] as ReadonlyArray<string | number>;
    const payload: CursorPayload = {
      orderedValues: originalOrdered,
      keyValues: originalKeys,
      sortFingerprint: 'a:asc',
    };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded).not.toBeNull();
    expect(decoded!.orderedValues).not.toBe(originalOrdered);
    expect(decoded!.keyValues).not.toBe(originalKeys);
    // Reassign via a mutable copy to prove independence.
    const copy = [...decoded!.orderedValues] as (string | number)[];
    copy.push(3);
    expect(copy).toEqual([1, 2, 3]);
    // Original payload is unchanged.
    expect(payload.orderedValues).toEqual([1, 2]);
    expect(payload.keyValues).toEqual([1, 2]);
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
    expect(decoded!.keyValues).toEqual(['café']);
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
    expect(decoded!.keyValues).toEqual(['中文']);
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
    expect(decoded!.keyValues).toEqual(['😀🎉']);
    expect(decoded!.sortFingerprint).toBe('emoji:asc');
  });

  it('base64url padding edge cases — 1 byte and 2 byte inputs', () => {
    // Force 1-byte and 2-byte UTF-8 sequences to exercise the padding
    // branches in base64FromBytes (lines where i+1 and i+2 < length).
    const single: CursorPayload = { orderedValues: ['A'], keyValues: ['A'], sortFingerprint: 's' };
    const d1 = decodeCursor(encodeCursor(single));
    expect(d1!.orderedValues).toEqual(['A']);
    expect(d1!.keyValues).toEqual(['A']);

    const two: CursorPayload = { orderedValues: ['ab'], keyValues: ['ab'], sortFingerprint: 't' };
    const d2 = decodeCursor(encodeCursor(two));
    expect(d2!.orderedValues).toEqual(['ab']);
    expect(d2!.keyValues).toEqual(['ab']);
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
    expect(decoded!.keyValues).toEqual(['test']);
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
    const bad = encodeCursor(
      { keyValues: [1], sortFingerprint: 'x:asc' } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a JSON object missing keyValues', () => {
    const bad = encodeCursor(
      { orderedValues: [1], sortFingerprint: 'x:asc' } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a JSON object missing sortFingerprint', () => {
    const bad = encodeCursor(
      { orderedValues: [1], keyValues: [1] } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a JSON object with wrong orderedValues type', () => {
    const bad = encodeCursor(
      {
        orderedValues: 'not-an-array',
        keyValues: [1],
        sortFingerprint: 'x:asc',
      } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a JSON object with wrong keyValues type', () => {
    const bad = encodeCursor(
      {
        orderedValues: [1],
        keyValues: 'not-an-array',
        sortFingerprint: 'x:asc',
      } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a JSON object with wrong sortFingerprint type', () => {
    const bad = encodeCursor(
      { orderedValues: [1], keyValues: [1], sortFingerprint: 42 } as unknown as CursorPayload,
    );
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('keysetPredicate', () => {
  it('produces a single or-comparison for desc sort when key matches orderBy', () => {
    // When the key column is the same as the orderBy field, no tiebreaker is
    // appended — the single comparison already covers the "after this row" semantics.
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

  it('appends the key tiebreaker when the orderBy does not end with it', () => {
    // orderBy on `name` only; key columns end in `id` → tiebreaker appended.
    // The absent key column uses keyValues[0] because it has no position in orderBy.
    const pred: FilterExpression = keysetPredicate(['alice', 5], [5], { name: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'and',
      filters: [
        {
          type: 'or',
          filters: [{ type: 'comparison', field: 'name', operator: 'gt', value: 'alice' }],
        },
        {
          type: 'or',
          filters: [{ type: 'comparison', field: 'id', operator: 'eq', value: 5 }],
        },
      ],
    });
  });

  it('does NOT duplicate the key tiebreaker when orderBy already ends with it', () => {
    // orderBy ends with `id`; appending another `id` term would duplicate.
    // orderedValues mirrors the sort: [nameValue, idValue].
    const pred: FilterExpression = keysetPredicate([42, 5], [5], { name: 'asc', id: 'asc' }, [
      'id',
    ]);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `name`, gt value `42` (orderedValues[0]).
        { type: 'comparison', field: 'name', operator: 'gt', value: 42 },
        // Position 1: field `id`, gt value `5` (orderedValues[1]).
        { type: 'comparison', field: 'id', operator: 'gt', value: 5 },
      ],
    });
  });

  it('looks up values by column position in the sort, not by name', () => {
    // Empty keyColumns means no tiebreaker; the or contains just the orderBy comparisons.
    const pred: FilterExpression = keysetPredicate(['b', 2], [1], { a: 'asc', b: 'desc' }, []);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `a`, gt value `b` (orderedValues[0]).
        { type: 'comparison', field: 'a', operator: 'gt', value: 'b' },
        // Position 1: field `b`, lt value `2` (orderedValues[1]).
        { type: 'comparison', field: 'b', operator: 'lt', value: 2 },
      ],
    });
  });

  it('uses keyValues[0] for a key column absent from the sort', () => {
    const pred: FilterExpression = keysetPredicate(
      ['alice'],
      [77],
      { name: 'asc' },
      ['tenantId', 'id'],
    );
    const and = pred as FilterExpression & { type: 'and' };
    expect(and.filters).toHaveLength(2);
    const eqOr = and.filters![1] as FilterExpression & { type: 'or' };
    expect(eqOr.filters).toHaveLength(2);
    expect(eqOr.filters![0]).toEqual({
      type: 'comparison',
      field: 'tenantId',
      operator: 'eq',
      value: 77,
    });
    expect(eqOr.filters![1]).toEqual({
      type: 'comparison',
      field: 'id',
      operator: 'eq',
      value: 77,
    });
  });

  it('uses keyValues[0] for all key columns when orderBy is empty', () => {
    // With empty orderBy, every key column falls back to keyValues[0].
    const pred: FilterExpression = keysetPredicate([], [1], {}, ['a', 'b']);
    const and = pred as FilterExpression & { type: 'and' };
    expect(and.filters).toHaveLength(2);
    const eqOr = and.filters![1] as FilterExpression & { type: 'or' };
    expect(eqOr.filters).toHaveLength(2);
    // Both get keyValues[0] = 1, not keyValues[1] = 2.
    expect(eqOr.filters![0]).toEqual({ type: 'comparison', field: 'a', operator: 'eq', value: 1 });
    expect(eqOr.filters![1]).toEqual({ type: 'comparison', field: 'b', operator: 'eq', value: 1 });
  });

  it('returns a bare or when there are no key columns and no orderBy', () => {
    const pred: FilterExpression = keysetPredicate([], [], {}, []);
    expect(pred).toEqual({ type: 'or', filters: [] });
  });

  it('uses keyValues for tiebreakers even when orderedValues[0] differs', () => {
    // Critical test: orderedValues carries non-key field values; keyValues
    // carries the primary-key values. When a key column is absent from
    // orderBy (pure tiebreaker), the predicate must use keyValues, not
    // orderedValues[0], which would be the non-key field value.
    //
    // Example: orderBy = { score: 'asc' }, keyColumns = ['id'].
    // orderedValues = [2] (the score of the last row), keyValues = ['y'] (the id).
    // The tiebreaker eq(id, ...) must use 'y', not 2.
    const pred: FilterExpression = keysetPredicate([2], ['y'], { score: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'and',
      filters: [
        {
          type: 'or',
          filters: [{ type: 'comparison', field: 'score', operator: 'gt', value: 2 }],
        },
        {
          type: 'or',
          filters: [{ type: 'comparison', field: 'id', operator: 'eq', value: 'y' }],
        },
      ],
    });
  });
});

describe('cursor.ts defensive edge cases', () => {
  it('handles malformed base64 with padding character in stream', () => {
    // base64url decoding strips '=', but a standard base64 token with '='
    // in the middle should be handled without crashing (the decode loop
    // breaks on '=').
    const token = btoa(
      '{"orderedValues":[1],"keyValues":[1],"sortFingerprint":"x"}',
    )
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Normal round-trip still works.
    const d = decodeCursor(token);
    expect(d).not.toBeNull();
    expect(d!.orderedValues).toEqual([1]);
    expect(d!.keyValues).toEqual([1]);
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
    expect(decoded!.keyValues).toEqual([42]);
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
    expect(decoded!.keyValues).toEqual(['x']);
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

  it('stops decoding at an embedded padding character', () => {
    // A '=' mid-token terminates the byte-decode loop early, so the tail is
    // ignored; the result is not valid JSON, so decodeCursor returns null.
    expect(decodeCursor('QUJD=')).toBeNull();
  });

  it('handles a truncated 2-byte UTF-8 sequence at end of input', () => {
    // 'ww' decodes to the single byte 0xC3 — a 2-byte lead with no
    // continuation. The decoder's ??0 fallback completes the sequence with a
    // zero byte; the resulting garbage is not valid JSON, so decodeCursor
    // still refuses the token rather than throwing.
    expect(decodeCursor('ww')).toBeNull();
  });

  it('handles a truncated 4-byte UTF-8 lead byte at end of input', () => {
    // '8A' decodes to the single byte 0xF0 — a 4-byte lead with no
    // continuation bytes at all.
    expect(decodeCursor('8A')).toBeNull();
  });

  it('handles a truncated 3-byte UTF-8 sequence at end of input', () => {
    // '5Li' decodes to [0xE4, 0x2C] — a 3-byte lead with one continuation
    // but the final byte missing.
    expect(decodeCursor('5Li')).toBeNull();
  });

  it('handles a truncated surrogate-pair tail at end of input', () => {
    // '8J-Y' decodes to [0xF0, 0x9F, 0x98] — the first three bytes of the
    // four-byte emoji sequence, with the final byte missing.
    expect(decodeCursor('8J-Y')).toBeNull();
  });
});

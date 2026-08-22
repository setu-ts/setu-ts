/**
 * Unit tests for `normalizeMetadata` (X2-5).
 *
 * The helper replaces every top-level `Error` in log metadata with its plain,
 * serializable `serializeError` representation, leaving all other values —
 * including nested objects and arrays — untouched. These tests pin every
 * branch: a single `Error`, multiple `Errors`, an `Error` mixed with other
 * values, and the no-`Error` fast paths (empty and non-empty metadata).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { normalizeMetadata } from '../../src/loggers/normalize-metadata.ts';

describe('normalizeMetadata', () => {
  it('replaces a single Error with its serialized form', () => {
    const err = new Error('boom');
    const result = normalizeMetadata({ error: err });

    expect(result.error).toEqual({ name: 'Error', message: 'boom', stack: err.stack });
  });

  it('leaves non-Error values untouched', () => {
    const nested = { a: 1 };
    const result = normalizeMetadata({
      count: 3,
      flag: true,
      label: 'x',
      nested,
      list: [1, 2, 3],
    });

    expect(result.count).toBe(3);
    expect(result.flag).toBe(true);
    expect(result.label).toBe('x');
    expect(result.nested).toBe(nested);
    expect(result.list).toEqual([1, 2, 3]);
  });

  it('replaces every Error when several are present', () => {
    const a = new Error('first');
    const b = new Error('second');
    const result = normalizeMetadata({ first: a, second: b });

    expect(result.first).toEqual({ name: 'Error', message: 'first', stack: a.stack });
    expect(result.second).toEqual({ name: 'Error', message: 'second', stack: b.stack });
  });

  it('normalizes Errors while preserving sibling values', () => {
    const err = new TypeError('bad');
    const result = normalizeMetadata({ requestId: 'r-1', error: err, ok: false });

    expect(result.requestId).toBe('r-1');
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ name: 'TypeError', message: 'bad', stack: err.stack });
  });

  it('returns an empty object for empty metadata', () => {
    expect(normalizeMetadata({})).toEqual({});
  });

  it('does not mutate the input object', () => {
    const err = new Error('boom');
    const input = { error: err, keep: 1 };
    const result = normalizeMetadata(input);

    // The original still carries the raw Error; the copy carries the serialized form.
    expect(input.error).toBe(err);
    expect(result.error).not.toBe(err);
    expect(result.keep).toBe(1);
  });

  it('returns a fresh copy even when no Error is present', () => {
    // The documented contract (M70f re-review round 2, finding 6): the
    // implementation always returns a shallow copy, so a caller that memoizes
    // on the metadata reference cannot accidentally alias the normalized
    // object with its own.
    const input = { count: 3, label: 'x' };
    const result = normalizeMetadata(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

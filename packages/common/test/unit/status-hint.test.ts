/**
 * The HTTP status hint (M89b, X19-1): the symbol-keyed brand through which a
 * package that may not import `@setu-ts/exceptions` (AI_GUIDELINES §2.2)
 * states how its own error should be answered.
 *
 * The cross-copy case is the reason the key is `Symbol.for` rather than
 * `Symbol()`: importing the module under a distinct URL makes Deno instantiate
 * its own module-level constants, which is the same situation as two copies of
 * this package resolved into one process (the M64 `context-marker-copies`
 * technique, followed here as `validation-metadata.test.ts` does).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  HTTP_STATUS_HINT,
  type HttpStatusHint,
  httpStatusHintOf,
  withHttpStatusHint,
} from '../../src/errors/status-hint.ts';

const secondCopy = await import('../../src/errors/status-hint.ts?copy=2');

/** The shape `@setu-ts/database-plugin` brands its query-shape refusals with. */
const NOT_IMPLEMENTED: HttpStatusHint = {
  status: 501,
  title: 'Not Implemented',
  detail: "Query feature 'orderBy' is not supported by the 'dynamodb' database adapter.",
};

describe('HTTP status hint', () => {
  it('should return the SAME error reference, branded', () => {
    // Branding in place is what lets a constructor call it on `this` and a
    // thrower write `throw withHttpStatusHint(new X(...), hint)`.
    const error = new Error('boom');
    const returned = withHttpStatusHint(error, NOT_IMPLEMENTED);

    expect(returned).toBe(error);
    expect(httpStatusHintOf(error)).toEqual(NOT_IMPLEMENTED);
  });

  it('should leave the error otherwise untouched', () => {
    // The brand must not change how the error behaves for anything that
    // already reads it — `instanceof`, the message, or the cause chain.
    class Refusal extends Error {
      override readonly name = 'Refusal';
    }
    const cause = new Error('driver said no');
    const error = new Refusal('the full diagnostic', { cause });
    withHttpStatusHint(error, NOT_IMPLEMENTED);

    expect(error).toBeInstanceOf(Refusal);
    expect(error.message).toBe('the full diagnostic');
    expect(error.cause).toBe(cause);
  });

  it('should be invisible to enumeration and serialization', () => {
    // Non-enumerable and symbol-keyed, so a hinted error still serializes and
    // spreads exactly as it did — the brand is a channel, not a payload.
    const error = withHttpStatusHint(new Error('boom'), NOT_IMPLEMENTED);

    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify({ ...error })).toBe('{}');
  });

  it('should read undefined from an unbranded error', () => {
    expect(httpStatusHintOf(new Error('boom'))).toBeUndefined();
  });

  it('should read undefined from a thrown non-object', () => {
    // `catch` binds `unknown`, and a thrown string or null is legal
    // JavaScript, so the reader must not dereference them.
    expect(httpStatusHintOf('a thrown string')).toBeUndefined();
    expect(httpStatusHintOf(null)).toBeUndefined();
    expect(httpStatusHintOf(undefined)).toBeUndefined();
    expect(httpStatusHintOf(42)).toBeUndefined();
  });

  it('should treat a foreign value under the same global symbol as ABSENT', () => {
    // Another library could stamp anything under `Symbol.for(...)`. Trusting
    // it would let a third party choose the status and body of a response.
    const error = new Error('boom');
    Object.defineProperty(error, HTTP_STATUS_HINT, {
      value: { status: '501', title: 'Not Implemented', detail: 'x' },
      configurable: true,
    });

    expect(httpStatusHintOf(error)).toBeUndefined();
  });

  it('should reject a brand missing any required member', () => {
    // Each of the three is served, so a hint short one member would answer
    // with an `undefined` status, title or detail.
    for (
      const partial of [
        { title: 'Not Implemented', detail: 'x' },
        { status: 501, detail: 'x' },
        { status: 501, title: 'Not Implemented' },
      ]
    ) {
      const error = new Error('boom');
      Object.defineProperty(error, HTTP_STATUS_HINT, { value: partial, configurable: true });
      expect(httpStatusHintOf(error)).toBeUndefined();
    }
  });

  it('should reject a non-object brand value', () => {
    const error = new Error('boom');
    Object.defineProperty(error, HTTP_STATUS_HINT, { value: 501, configurable: true });

    expect(httpStatusHintOf(error)).toBeUndefined();
  });

  it('should reject a null brand value', () => {
    const error = new Error('boom');
    Object.defineProperty(error, HTTP_STATUS_HINT, { value: null, configurable: true });

    expect(httpStatusHintOf(error)).toBeUndefined();
  });

  it('should use a GLOBAL symbol, so two copies of this package agree', () => {
    // `Symbol()` would miss on every read when two copies share a process —
    // the failure M37c hit with hand-written React Router context keys, and
    // the reason M57's SECURITY_METADATA uses `Symbol.for` too.
    expect(HTTP_STATUS_HINT).toBe(Symbol.for('setu.http.status-hint'));
  });

  it('really is a separate module copy', () => {
    // Vacuity guard for the test below: if Deno ever deduplicated these, the
    // cross-copy assertion would prove nothing.
    expect(secondCopy.withHttpStatusHint).not.toBe(withHttpStatusHint);
    expect(secondCopy.HTTP_STATUS_HINT).toBe(HTTP_STATUS_HINT);
  });

  it('should be readable through a SEPARATE module instance of this package', () => {
    // The real cross-copy case: `database-plugin` brands through its copy of
    // `common` and `exceptions` reads through its own. A local `Symbol()`
    // would make every one of those reads miss — silently, since a miss is
    // indistinguishable from an unbranded error and simply restores the
    // masked 500 this closes.
    const branded = secondCopy.withHttpStatusHint(new Error('boom'), NOT_IMPLEMENTED);

    expect(httpStatusHintOf(branded)).toEqual(NOT_IMPLEMENTED);
  });
});

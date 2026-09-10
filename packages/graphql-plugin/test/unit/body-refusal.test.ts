/**
 * V5-1 — a REFUSED request body must be reported as the refusal, not as a
 * malformed one.
 *
 * Since M90a `ctx.request.json()` can REJECT rather than return:
 * `RuntimePlugin({ maxBodyBytes })` bounds the read and rejects with a
 * `RequestBodyTooLargeError` branded with a `413` status hint. Both GraphQL
 * transports wrapped that read in a `try` whose `catch` answered
 * `400 INVALID_JSON`, which names the wrong cause and the wrong remedy — the
 * body was never parsed, so it was never invalid, and a client told its JSON
 * is bad re-sends the same oversized document.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MalformedRequestBodyError, withHttpStatusHint } from '@setu-ts/common';
import { bodyRefusalOf } from '../../src/http/body-refusal.ts';

/** An error branded exactly as the runtime's body cap brands its own. */
function refusedWith(status: number, detail: string): Error {
  return withHttpStatusHint(new Error('internal diagnostic, never served'), {
    status,
    title: 'Refused',
    detail,
  });
}

describe('bodyRefusalOf', () => {
  it('maps a 413-hinted rejection to the size-specific code', () => {
    const refusal = bodyRefusalOf(
      refusedWith(413, 'Request body exceeds the configured maximum of 1024 bytes.'),
    );
    expect(refusal).toEqual({
      status: 413,
      message: 'Request body exceeds the configured maximum of 1024 bytes.',
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  });

  it('maps any other hinted rejection to the generic code, keeping its status', () => {
    // The hint is a `Symbol.for` brand any package can attach, so a status
    // this mapping has never seen must still reach the client as something it
    // can branch on rather than as a mislabelled size error.
    expect(bodyRefusalOf(refusedWith(429, 'Slow down.'))).toEqual({
      status: 429,
      message: 'Slow down.',
      code: 'REQUEST_REFUSED',
    });
  });

  it('serves the hint detail, never the error message', () => {
    // The message may quote internals; the hint's `detail` is the sentence
    // the thrower chose to disclose.
    const refusal = bodyRefusalOf(refusedWith(413, 'Too large.'));
    expect(refusal?.message).toBe('Too large.');
    expect(refusal?.message).not.toContain('internal diagnostic');
  });

  it('reports null for an ordinary parse failure, so the 400 path is kept', () => {
    expect(bodyRefusalOf(new SyntaxError('Unexpected token < in JSON at position 0'))).toBeNull();
  });

  it('reports null for the shared malformed-body rejection, though it IS hinted', () => {
    // MEASURED, and the reason this exclusion exists: since M90f
    // `parseJsonBody` rejects with an error carrying its own `400` hint, so a
    // classifier that honoured every hint would replace the published
    // `INVALID_JSON` code with a generic one on the commonest failure there
    // is. Deleting the exclusion fails this and the end-to-end malformed case.
    const malformed = new MalformedRequestBodyError(new SyntaxError('Unexpected token'));
    expect(bodyRefusalOf(malformed)).toBeNull();
  });

  it('reports null for a look-alike from another copy of common', () => {
    // `instanceof` misses when two copies of `@setu-ts/common` share a
    // process, which is exactly the case the hint's `Symbol.for` key survives;
    // the class documents `name` as the discriminant for it.
    const crossRealm = withHttpStatusHint(new Error('The request body is not valid JSON.'), {
      status: 400,
      title: 'Bad Request',
      detail: 'The request body could not be parsed as JSON.',
    });
    Object.defineProperty(crossRealm, 'name', { value: 'MalformedRequestBodyError' });
    expect(bodyRefusalOf(crossRealm)).toBeNull();
  });

  it('reports null for a thrown non-error value', () => {
    expect(bodyRefusalOf('nope')).toBeNull();
    expect(bodyRefusalOf(undefined)).toBeNull();
  });

  it('classifies a value whose `name` getter throws, rather than throwing itself', () => {
    // This runs inside the transports' `catch`, so an escape here replaces the
    // refusal the caller is entitled to with the kernel's 500 — the error path
    // becoming the fault.
    const hostile = withHttpStatusHint(new Error('too large'), {
      status: 413,
      title: 'Payload Too Large',
      detail: 'The request body exceeds the configured limit.',
    });
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('accessor exploded');
      },
    });
    expect(bodyRefusalOf(hostile)).toEqual({
      status: 413,
      message: 'The request body exceeds the configured limit.',
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  });

  it('classifies a proxy whose traps throw, rather than throwing itself', () => {
    const hostile = new Proxy({}, {
      get(): never {
        throw new Error('trap exploded');
      },
      getPrototypeOf(): never {
        throw new Error('trap exploded');
      },
    });
    expect(bodyRefusalOf(hostile)).toBeNull();
  });
});

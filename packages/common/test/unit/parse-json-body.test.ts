/**
 * `parseJsonBody` / `MalformedRequestBodyError` (X37-1, M90f).
 *
 * The one JSON parse all three `IRequest.json()` implementations share. The
 * class carries a `400` status hint at construction, so a malformed body
 * reaches `errorHandler` as a caller-caused `400` instead of a masked `500`.
 * The end-to-end halves live in each producer's package (`runtime`,
 * `kernel`, `testing`); this file pins the shared contract itself.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf, parseJsonBody } from '../../src/index.ts';
import { MalformedRequestBodyError } from '../../src/index.ts';

describe('parseJsonBody', () => {
  it('valid JSON round-trips', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBody('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseJsonBody('"text"')).toBe('text');
    expect(parseJsonBody('null')).toBe(null);
    expect(parseJsonBody('{}')).toEqual({});
  });

  it('a malformed body throws MalformedRequestBodyError', () => {
    expect(() => parseJsonBody('not-json')).toThrow(MalformedRequestBodyError);
  });

  it('the empty string throws — there is no JSON in nothing', () => {
    expect(() => parseJsonBody('')).toThrow(MalformedRequestBodyError);
  });

  it('the platform SyntaxError is the cause', () => {
    try {
      parseJsonBody('{oops');
      throw new Error('parseJsonBody should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedRequestBodyError);
      expect((error as MalformedRequestBodyError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('the error carries a 400 status hint with a fixed, body-free sentence', () => {
    const hint = httpStatusHintOf(new MalformedRequestBodyError(new SyntaxError('internal')));
    expect(hint).toBeDefined();
    expect(hint?.status).toBe(400);
    expect(hint?.title).toBe('Bad Request');
    // The served sentence is composed at the brand site and never quotes the
    // underlying SyntaxError — the masking exemption stays narrow (§3.7).
    expect(hint?.detail).toBe('The request body could not be parsed as JSON.');
    expect(hint?.detail).not.toContain('internal');
  });

  it('the error name is the class name, for instanceof-free consumers', () => {
    expect(new MalformedRequestBodyError(new SyntaxError()).name).toBe('MalformedRequestBodyError');
  });
});

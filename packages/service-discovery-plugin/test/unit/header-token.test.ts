/**
 * `headerSafeToken` (M139f audit M1, N1): a credential a header cannot carry
 * is refused with the caller's fixed message, never echoed.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { headerSafeToken } from '../../src/http/header-token.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';

const REFUSAL = 'fixed refusal';

describe('headerSafeToken', () => {
  it('returns a visible-ASCII token unchanged, including an empty one', () => {
    for (const token of ['eyJhbGciOi.payload_-~+/=.sig', 'acl-0123', '']) {
      expect(headerSafeToken(token, REFUSAL)).toBe(token);
    }
  });

  // Every character outside visible ASCII: those fetch quotes in its error,
  // and those it would send (TAB, space, Latin-1) — a token never holds them.
  for (const [label, character] of [
    ['LF', '\n'],
    ['CR', '\r'],
    ['NUL', '\u0000'],
    ['TAB', '\t'],
    ['space', ' '],
    ['DEL', '\u007f'],
    ['Latin-1', 'ö'],
    ['euro', '€'],
    ['line separator', ' '],
  ] as const) {
    it(`refuses ${label} with the fixed message`, () => {
      expect(() => headerSafeToken(`canary${character}token`, REFUSAL)).toThrow(
        new DiscoveryUnavailableError(REFUSAL),
      );
    });
  }
});

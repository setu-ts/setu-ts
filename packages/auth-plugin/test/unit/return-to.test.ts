/**
 * The `returnTo` allowlist (plan §3.7).
 *
 * Each rejected case is a real open-redirect vector: protocol-relative,
 * backslash-as-slash, an absolute URL, a `javascript:` payload, header injection
 * via a control character, and an oversized path that would blow the session
 * cookie budget.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MAX_RETURN_TO_BYTES, safeReturnTo } from '../../src/sign-in/return-to.ts';

describe('safeReturnTo', () => {
  it('keeps same-origin absolute paths', () => {
    for (const value of ['/a', '/', '/a/b/c', '/a?next=1', '/a#frag', '/a?b=1&c=2', '/é']) {
      expect(safeReturnTo(value)).toBe(value);
    }
  });

  it('rejects protocol-relative, backslash, absolute and scheme targets', () => {
    for (
      const value of [
        '//evil.test',
        '/\\evil.test',
        '/a/\\..\\..//evil.test',
        'https://evil.test',
        'http://evil.test/a',
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        'data:text/html,x',
        'evil.test/a',
        ' /a',
      ]
    ) {
      expect(safeReturnTo(value), value).toBe('/');
    }
  });

  it('rejects control characters including NUL, newline and DEL', () => {
    for (const char of ['\u0000', '\n', '\r', '\t', '\u001f', '\u007f']) {
      expect(safeReturnTo(`/a${char}b`)).toBe('/');
    }
  });

  it('bounds the value at 512 UTF-8 bytes', () => {
    const at = '/' + 'a'.repeat(MAX_RETURN_TO_BYTES - 1);
    const over = '/' + 'a'.repeat(MAX_RETURN_TO_BYTES);
    expect(safeReturnTo(at)).toBe(at);
    expect(safeReturnTo(over)).toBe('/');
    // The cap is bytes, not characters. `日` is three UTF-8 bytes, so 170 of
    // them (511 bytes) fit and 171 (514 bytes) do not — a character-count check
    // would wrongly accept the second.
    const threeByte = '日';
    expect(new TextEncoder().encode(threeByte).byteLength).toBe(3);
    const multibyte = '/' + threeByte.repeat(170);
    expect(new TextEncoder().encode(multibyte).byteLength).toBe(511);
    expect(safeReturnTo(multibyte)).toBe(multibyte);
    const tooLong = '/' + threeByte.repeat(171);
    expect(new TextEncoder().encode(tooLong).byteLength).toBe(514);
    expect(safeReturnTo(tooLong)).toBe('/');
    // A 2-byte `é` at the same character count is well under the cap.
    expect(safeReturnTo('/' + 'é'.repeat(170))).toBe('/' + 'é'.repeat(170));
  });

  it('accepts an explicit fallback for a rejected value', () => {
    expect(safeReturnTo('//evil.test', '/dashboard')).toBe('/dashboard');
    expect(safeReturnTo(undefined, '/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('', '/dashboard')).toBe('/dashboard');
  });

  it('treats a non-string as absent', () => {
    // The value comes from a query parameter, but a caller may hand anything.
    expect(safeReturnTo(7 as unknown as string, '/x')).toBe('/x');
  });
});

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
    for (const value of ['/a', '/', '/a/b/c', '/a?next=1', '/a#frag', '/a?b=1&c=2']) {
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

  it('bounds the value at MAX_RETURN_TO_BYTES bytes', () => {
    const at = '/' + 'a'.repeat(MAX_RETURN_TO_BYTES - 1);
    const over = '/' + 'a'.repeat(MAX_RETURN_TO_BYTES);
    expect(safeReturnTo(at)).toBe(at);
    expect(safeReturnTo(over)).toBe('/');
    // The cap is on the ENCODED form, which is what reaches the cookie: `日`
    // encodes to nine characters, so 28 of them (253 + 1) fit and 29 do not —
    // a raw character count would wrongly accept the second.
    const fits = '/' + '日'.repeat(28);
    expect(safeReturnTo(fits)).toBe('/' + '%E6%97%A5'.repeat(28));
    expect(safeReturnTo('/' + '日'.repeat(29))).toBe('/');
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

  it('percent-encodes non-ASCII so the value is a legal Location header (M100c F3)', () => {
    const kept = safeReturnTo('/日本?q=é');
    expect(kept).toBe('/%E6%97%A5%E6%9C%AC?q=%C3%A9');
    // A ByteString: every code unit fits a header value.
    expect(() => new Headers({ location: kept })).not.toThrow();
    // The cap applies to the ENCODED form: 86 three-byte characters encode to
    // 258 characters, past the cap.
    expect(safeReturnTo('/' + '日'.repeat(86))).toBe('/');
    expect(MAX_RETURN_TO_BYTES).toBe(256);
  });
});

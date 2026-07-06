/**
 * Unit tests for the input sanitizer.
 *
 * Covers each sanitization rule individually, combined order-of-operations,
 * and the factory pattern (createSanitizer + sanitize).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createSanitizer, sanitize } from '../../src/sanitizers/sanitizer.ts';

/**
 * Build the expected HTML-encoded string programmatically to avoid
 * any markdown/templating interference with entity literals.
 * Expected: &<>"&#x27;
 */
function encodedHtmlEntities(): string {
  // Build entity string "&<>"&#x27;" using char codes
  // so the ampersand is never subject to HTML-entity interpretation.
  const amp = String.fromCharCode(38); // '&'
  return amp + 'amp;' + amp + 'lt;' + amp + 'gt;' + amp + 'quot;' + amp + '#x27;';
}

describe('sanitize — individual rules', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitize('  hello  ', { trim: true })).toBe('hello');
  });

  it('converts to lowercase', () => {
    expect(sanitize('HELLO World', { toLowerCase: true })).toBe('hello world');
  });

  it('converts to uppercase', () => {
    expect(sanitize('Hello World', { toUpperCase: true })).toBe('HELLO WORLD');
  });

  it('rejects with empty string when pattern does not match', () => {
    expect(sanitize('abc123', { pattern: /^[a-z]+$/ })).toBe('');
  });

  it('keeps value when pattern matches', () => {
    expect(sanitize('abc', { pattern: /^[a-z]+$/ })).toBe('abc');
  });

  it('strips all HTML tags', () => {
    expect(sanitize('<b>hello</b><i> world</i>', { stripTags: true })).toBe('hello world');
  });

  it('keeps only allowed tags', () => {
    // <i> and </i> are removed, leaving "hello" and "world" adjacent
    expect(
      sanitize('<b>hello<i>world</i></b>', { allowedTags: ['b'] }),
    ).toBe('<b>helloworld</b>');
  });

  it('encodes HTML entities literally', () => {
    // Regression guard: the sanitizer must produce literal entity strings,
    // not the raw characters. Build both input and expected programmatically
    // to avoid any markdown/templating interference.
    const input = String.fromCharCode(38, 60, 62, 34, 39); // &<>"'
    expect(sanitize(input, { htmlEncode: true })).toBe(encodedHtmlEntities());
  });

  it('truncates to maxLength', () => {
    expect(sanitize('hello world', { maxLength: 5 })).toBe('hello');
  });

  it('omits maxLength when value is short enough', () => {
    expect(sanitize('hi', { maxLength: 10 })).toBe('hi');
  });
});

describe('sanitize — order of operations', () => {
  it('applies trim → case → pattern → strip → encode → truncate', () => {
    const fn = createSanitizer({
      trim: true,
      toLowerCase: true,
      stripTags: true,
      htmlEncode: true,
      maxLength: 20,
    });

    // Input: "  <b>HELLO</b>  "
    //  1. trim        → "<b>HELLO</b>"
    //  2. toLowerCase → "<b>hello</b>"
    //  3. pattern     → (none)
    //  4. stripTags   → "hello"
    //  5. htmlEncode  → "hello" (no special chars)
    //  6. maxLength   → "hello" (within limit)
    expect(fn('  <b>HELLO</b>  ')).toBe('hello');
  });

  it('htmlEncode after stripTags encodes remaining text', () => {
    const fn = createSanitizer({
      stripTags: true,
      htmlEncode: true,
    });

    // "<script>alert('xss')</script>"
    //  stripTags → "alert('xss')"
    //  htmlEncode → "alert(&#x27;xss&#x27;)"
    const expected = 'alert(' + '&#x27;' + 'xss' + '&#x27;' + ')';
    expect(fn("<script>alert('xss')</script>")).toBe(expected);
  });

  it('truncate is final step regardless of other transforms', () => {
    const fn = createSanitizer({
      htmlEncode: true,
      maxLength: 5,
    });

    // "hello" → htmlEncode "hello" → truncate "hello"
    expect(fn('hello world')).toBe('hello');
  });
});

describe('createSanitizer — factory', () => {
  it('returns a reusable sanitization function', () => {
    const fn = createSanitizer({ trim: true });
    expect(fn('  a  ')).toBe('a');
    expect(fn('  b  ')).toBe('b');
  });

  it('sanitize() delegates to createSanitizer', () => {
    expect(sanitize(' x ', { trim: true })).toBe('x');
  });

  it('empty ruleset returns input unchanged', () => {
    expect(sanitize('hello', {})).toBe('hello');
  });
});

describe('sanitize — edge cases', () => {
  it('allowedTags empty array behaves like no allowed tags', () => {
    // When allowedTags is present but empty, the branch
    // `rules.allowedTags && rules.allowedTags.length > 0` is false,
    // so no tag processing occurs (neither strip nor keep).
    expect(sanitize('<b>hi</b>', { allowedTags: [] })).toBe('<b>hi</b>');
  });

  it('pattern replaces entire string when no match', () => {
    expect(sanitize('not-a-email', { pattern: /^[^@]+@[^@]+$/ })).toBe('');
  });

  it('toUpperCase after toLowerCase wins (last case transform)', () => {
    expect(
      sanitize('Hello', { toLowerCase: true, toUpperCase: true }),
    ).toBe('HELLO');
  });
});

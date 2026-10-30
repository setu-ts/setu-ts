import { describe, it, expect } from 'vitest';
import { MALFORMED, parseForwarded } from '../../src/middleware/forwarded-header.ts';

/** Inputs the strict pass refuses; each alone is one boundary. */
const MALFORMED_INPUTS = [
  '',
  ' ',
  ',',
  'for=',
  '=x',
  'for =192.0.2.1',
  'for=192.0.2.1,',
  'for=192.0.2.1, ',
  'for=192.0.2.1;',
  'for="unterminated',
  'for="a\\',
  'for="a\n"',
  'for="a\u007f"',
  'for=192.0.2.1;FOR=192.0.2.2',
  'for=192.0.2.1/x',
  'for="[garbage]"',
  'for="[::1]:bad"',
  'for="2001:db8::1"',
  'for=hostname',
  'for=256.1.2.3',
  'for=01.2.3.4',
  'for="_"',
] as const;

describe('bounded Forwarded parser', () => {
  it('parses quoted strings, escaped delimiters and case-insensitive names', () => {
    expect(
      parseForwarded(
        ' FoR=192.0.2.1;PrOtO=HTTPS;host="EXAMPLE.com:8443";ext="a\\",b\\\\c" , for="[2001:db8::1]:4711";proto=http',
      ),
    ).toEqual([
      { ip: '192.0.2.1', proto: 'HTTPS', host: 'EXAMPLE.com:8443' },
      { ip: '2001:db8::1', proto: 'http' },
    ]);
  });
  it('strips IPv4 ports and preserves unknown and obfuscated barriers', () => {
    expect(parseForwarded('for="192.0.2.1:443", for=unknown, for=_opaque, proto=https')).toEqual([
      { ip: '192.0.2.1' },
      {},
      {},
      { proto: 'https' },
    ]);
    expect(parseForwarded('for="[::ffff:192.0.2.1]";ext=""')).toEqual([{ ip: '192.0.2.1' }]);
  });
  it('shares canonical address spellings while retaining the RFC node and port grammar', () => {
    for (const [node, expected] of [
      ['[2001:DB8:0::1]', '2001:db8::1'],
      ['[::ffff:c000:201]:_opaque', '192.0.2.1'],
      ['192.0.2.1:_opaque', '192.0.2.1'],
      ['192.0.2.1:999999', '192.0.2.1'],
    ] as const) {
      expect(parseForwarded(`for="${node}"`), node).toEqual([{ ip: expected }]);
    }
    for (const node of ['[1.2.3.4]', '[fe80::1%eth0]', '[2001:::1]', '[g::1]']) {
      expect(parseForwarded(`for="${node}"`), node).toEqual([MALFORMED]);
    }
  });
  it('keeps a comma inside a quoted value in the strict pass', () => {
    // The recovery pass is NOT quote-aware, so this must never reach it: the
    // whole field is well formed and the strict pass reads it as one element.
    expect(parseForwarded('for=192.0.2.1;ext="a,b";host=example.com')).toEqual([
      { ip: '192.0.2.1', host: 'example.com' },
    ]);
  });
  it('turns malformed input alone into one boundary', () => {
    for (const bad of MALFORMED_INPUTS) {
      expect(parseForwarded(bad), bad).toEqual([MALFORMED]);
    }
  });
  it('re-reads malformed input from the right and keeps the appended element', () => {
    // The appending proxy writes the real client to the RIGHT of whatever the
    // caller sent, so the caller's malformed prefix is a boundary, not a void
    // (V10-19). Inputs that end in a separator put the appended element past an
    // empty segment, so the boundary covers the leading valid element too.
    for (const bad of MALFORMED_INPUTS) {
      expect(parseForwarded(`${bad}, for=198.51.100.7`), bad).toEqual([
        MALFORMED,
        { ip: '198.51.100.7' },
      ]);
    }
  });
  it('turns a comma-injecting or unclosed-quote prefix into one boundary', () => {
    // Not quote-aware on the recovery split: the unclosed quote is the
    // boundary and the appended element to its right is still read.
    expect(parseForwarded('for=1.1.1.1, for="x, for=198.51.100.7')).toEqual([
      MALFORMED,
      { ip: '198.51.100.7' },
    ]);
    expect(parseForwarded('for=1.1.1.1, for="x')).toEqual([MALFORMED]);
    expect(parseForwarded('for=1.1.1.1;FOR=1.1.1.2, for=198.51.100.7')).toEqual([
      MALFORMED,
      { ip: '198.51.100.7' },
    ]);
  });
  it('bounds the complete field to 8 KiB and 64 elements, recovering from the right', () => {
    expect(parseForwarded(`for=192.0.2.1;ext="${'a'.repeat(8192)}"`)).toEqual([MALFORMED]);
    // The recovery window is cut before a multi-byte character rather than
    // inside it.
    expect(parseForwarded(`ext="${'é'.repeat(4100)}"`)).toEqual([MALFORMED]);
    const sixtyFive = Array(65).fill('for=192.0.2.1').join(',');
    expect(parseForwarded(sixtyFive)).toEqual([MALFORMED, ...Array(64).fill({ ip: '192.0.2.1' })]);
    expect(parseForwarded(Array(64).fill('for=192.0.2.1').join(','))).toHaveLength(64);
    const prefix = 'for=192.0.2.1;ext="';
    expect(parseForwarded(`${prefix}${'a'.repeat(8192 - prefix.length - 1)}"`)).toEqual([
      { ip: '192.0.2.1' },
    ]);
  });
  it('keeps the appended element behind a padding prefix past the window', () => {
    const padding = 'a'.repeat(9 * 1024);
    expect(parseForwarded(`${padding}, for=198.51.100.7`)).toEqual([
      MALFORMED,
      { ip: '198.51.100.7' },
    ]);
  });
  it('walks a window of multi-byte and surrogate code points without splitting them', () => {
    // Each of these fails the strict pass and drives the window walk over a
    // two-, three- and four-byte code point, including a surrogate pair and a
    // lone low surrogate. The result is a single boundary in every case; the
    // point is that the walk never throws or emits U+FFFD.
    for (const value of ['é', 'あ', '😀', 'a\udc00']) {
      expect(parseForwarded(value), value).toEqual([MALFORMED]);
    }
  });
  it('finishes a 16 KiB comma field within the window budget', () => {
    const field = `${'a'.repeat(16 * 1024 - 8000)}${','.repeat(8000)}`;
    const parsed = parseForwarded(field);
    expect(parsed.length).toBeLessThanOrEqual(65);
    expect(parsed[0]).toBe(MALFORMED);
  });
  it('trims a segment with a long inner run of whitespace in linear time (audit M1)', () => {
    for (const run of [' ', '\t']) {
      const parsed = parseForwarded(`x${run.repeat(8000)}y, for=198.51.100.7`);
      expect(parsed).toEqual([MALFORMED, { ip: '198.51.100.7' }]);
    }
    // Surrounding whitespace is still trimmed in recovery.
    expect(parseForwarded(`garbage!,\t  for=198.51.100.7 \t`)).toEqual([
      MALFORMED,
      { ip: '198.51.100.7' },
    ]);
  });
  it('refuses a bracketed node carrying userinfo (audit L1)', () => {
    expect(parseForwarded('for="[x@[::1]"')).toEqual([MALFORMED]);
    expect(parseForwarded('for="[x@[::1]", for=198.51.100.7')).toEqual([
      MALFORMED,
      { ip: '198.51.100.7' },
    ]);
    expect(parseForwarded('for="[::1]:443"')).toEqual([{ ip: '::1' }]);
  });
});

/**
 * Unit tests for the generated-prose wrapper.
 *
 * X2-4: generated Markdown used to be hand-wrapped in the template literal that
 * produced it, which works only for the exact values the author interpolated —
 * so a `--transport rabbitmq` workspace failed its own `deno fmt --check` on two
 * READMEs, one wrapped too narrow and the other not wrapped at all. These pin
 * the behaviour that removes the class rather than the instance.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { wrapProse } from '../../../src/utils/wrap-prose.ts';

/** The width the generated `fmt` config sets, and what `deno fmt --check` enforces. */
const LINE_WIDTH = 100;

/** A sentence of `count` five-character words, so lengths are easy to reason about. */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${String(index).padStart(3, '0')}`).join(
    ' ',
  );
}

describe('wrapProse', () => {
  it('leaves a paragraph that already fits on one line', () => {
    expect(wrapProse('short enough')).toBe('short enough');
  });

  it('keeps every emitted line within the formatter width', () => {
    // The property that matters: `deno fmt --check` fails on any line past the
    // configured width, so this is the assertion the defect would have failed.
    for (const line of wrapProse(words(60)).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  it('fills each line rather than breaking early', () => {
    // The too-NARROW half of the defect: a hand-wrapped paragraph written around
    // a shorter interpolated value left lines `deno fmt` would rejoin.
    const lines = wrapProse(words(60)).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBeGreaterThan(LINE_WIDTH - 10);
    }
  });

  it('discards the input own line breaks and re-flows the words', () => {
    // Whitespace-insensitive by design, so a caller may write the source however
    // it reads best in the template literal.
    expect(wrapProse('one\ntwo   three\n\nfour')).toBe('one two three four');
  });

  it('indents every line after the first, and never the first', () => {
    const lines = wrapProse(words(60), '  ').split('\n');
    expect(lines[0]?.startsWith(' ')).toBe(false);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
    }
  });

  it('counts the indent against the width, so an indented block still fits', () => {
    for (const line of wrapProse(words(60), '    ').split('\n')) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  it('places an over-long word on its own line rather than breaking it', () => {
    // `deno fmt` does not break a word either, so breaking one here would produce
    // output the formatter immediately rejoins — a URL is the real case.
    const long = 'x'.repeat(LINE_WIDTH + 20);
    expect(wrapProse(`before ${long} after`).split('\n')).toEqual(['before', long, 'after']);
  });

  it('returns an empty string for input with no words', () => {
    expect(wrapProse('')).toBe('');
    expect(wrapProse('   \n  ')).toBe('');
    expect(wrapProse('', '  ')).toBe('');
  });

  it('returns a single word unchanged, indent or not', () => {
    expect(wrapProse('solo')).toBe('solo');
    expect(wrapProse('solo', '  ')).toBe('solo');
  });
});

import { describe, expect, it } from 'vitest';
import {
  BRIEF_BEGIN as begin,
  BRIEF_END as end,
  briefSection,
  normalizeBrief,
  spliceBrief,
} from '../../../src/agents/brief-file.ts';

describe('framework section ownership', () => {
  it('H3 writes one final newline without growth across replacements', () => {
    const first = `${begin}\n\none\n\n${end}\n`;
    const next = `${begin}\n\ntwo\n\n${end}\n`;
    expect(spliceBrief('', first)).toBe(first);
    const once = spliceBrief(first, next);
    expect(once).toBe(next);
    expect(spliceBrief(once, first)).toBe(first);
    expect(spliceBrief(first, first)).toBe(first);
  });
  it('ignores formatter whitespace but not a joined list item or heading (CodeRabbit #582)', () => {
    const brief = `${begin}\n\n## Commands\n\n- \`a\` — one\n- \`b\` — two\n\n${end}`;
    expect(normalizeBrief(`${begin}\n## Commands\n-   \`a\` — one  \n- \`b\`  — two\n${end}`)).toBe(
      normalizeBrief(brief),
    );
    expect(normalizeBrief(brief.replace('one\n- ', 'one - '))).not.toBe(normalizeBrief(brief));
    expect(normalizeBrief(brief.replace('## Commands\n\n', '## Commands '))).not.toBe(
      normalizeBrief(brief),
    );
  });
  it('keeps blank lines after the end marker byte for byte (CodeRabbit #582)', () => {
    const next = `${begin}\nnew\n${end}`;
    expect(spliceBrief(`${begin}\nold\n${end}\n\n\n`, next)).toBe(`${next}\n\n\n`);
  });
  const section = `${begin}\nnew\n${end}`;
  it('creates or prepends, preserving all existing bytes', () => {
    expect(briefSection('personal')).toBeUndefined();
    expect(spliceBrief('', section)).toBe(`${section}\n`);
    expect(spliceBrief('personal\r\n\0é', section)).toBe(`${section}\n\npersonal\r\n\0é`);
  });
  it('replaces the section and preserves prefix and suffix byte for byte', () => {
    expect(spliceBrief(`é\r\n${begin}\nold\n${end}\r\n尾`, section)).toBe(`é\r\n${section}\r\n尾`);
  });
  for (const source of [
    begin,
    end,
    `${begin}${begin}${end}`,
    `${begin}${end}${end}`,
    `${end}${begin}`,
    `${begin}${end}${begin}${end}`,
  ]) {
    it(`refuses malformed markers: ${source}`, () =>
      expect(() => spliceBrief(source, section)).toThrow(/marker/));
  }
});

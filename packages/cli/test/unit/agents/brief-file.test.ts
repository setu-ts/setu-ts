import { describe, expect, it } from 'vitest';
import {
  BRIEF_BEGIN as begin,
  BRIEF_END as end,
  briefSection,
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

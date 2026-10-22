/** Delimiters and lossless splicing of the CLI-owned framework section. */
export const BRIEF_BEGIN = '<!-- setu-agents:begin -->';
/** End of the CLI-owned section. */
export const BRIEF_END = '<!-- setu-agents:end -->';

/** Locate a section, refusing ambiguous ownership before any write. */
export function briefSection(source: string): { start: number; end: number } | undefined {
  const begins = [...source.matchAll(/<!-- setu-agents:begin -->/g)];
  const ends = [...source.matchAll(/<!-- setu-agents:end -->/g)];
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error('expected exactly one begin marker and one end marker');
  }
  if (ends[0].index < begins[0].index) throw new Error('end marker precedes begin marker');
  return { start: begins[0].index, end: ends[0].index + BRIEF_END.length };
}

/** Replace only the section; preserve every byte outside its markers. */
export function spliceBrief(source: string, section: string): string {
  const range = briefSection(source);
  if (range === undefined) return section + '\n' + (source === '' ? '' : '\n' + source);
  return source.slice(0, range.start) + section + source.slice(range.end);
}

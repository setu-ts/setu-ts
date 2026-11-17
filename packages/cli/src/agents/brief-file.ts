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

/**
 * Formatter-insensitive freshness, shared by checking and writing.
 *
 * Ignores what Prettier and `deno fmt` change — blank lines, trailing and
 * repeated spaces — but keeps every line boundary, so two list items or a
 * heading joined onto one line still read as a changed section.
 */
export function normalizeBrief(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** Replace only the section; preserve every byte outside its markers. */
export function spliceBrief(source: string, section: string): string {
  const range = briefSection(source);
  const rendered = section.replace(/[\r\n]+$/, '');
  if (range === undefined) return rendered + '\n' + (source === '' ? '' : '\n' + source);
  const terminator = source.startsWith('\r\n', range.end) ? '\r\n' : '\n';
  // Every byte after the marker's own line terminator is the user's, blank
  // lines included.
  const suffix = source.slice(range.end).replace(/^\r?\n/, '');
  const body =
    normalizeBrief(source.slice(range.start, range.end)) === normalizeBrief(section)
      ? source.slice(range.start, range.end)
      : rendered;
  return source.slice(0, range.start) + body + terminator + suffix;
}

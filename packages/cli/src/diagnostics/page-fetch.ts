/**
 * `setu.W007` page-fetches-own-api (M142 §3.12): a module under `app/` that
 * calls `fetch()` with a path under `/api/`.
 *
 * A page reads through its loader and writes through its action; the
 * application's `/api` routes are for callers outside it. The scan reuses
 * E017's pipeline: the page is the JavaScript esbuild emits for it, read by
 * the shared lexer (so JSX text cannot be mistaken for a string, and a
 * template literal's substitutions are read as code), and each finding is
 * mapped back to its line in the original source through esbuild's source map.
 *
 * @module
 */

import { lexApiFetches } from '../utils/import-specifiers.ts';

/** One `fetch` of the application's own `/api` from a page. */
export interface PageApiFetch {
  /** The page, project-relative. */
  readonly path: string;
  /** The line of the call's argument in the original source. */
  readonly line: number;
  /** The path as written; a template's substitution is shown as `${…}`. */
  readonly target: string;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes one source-map segment's Base64 VLQ fields.
 *
 * @param segment - The segment's characters
 * @returns Its fields, or undefined for a character outside Base64
 */
function decodeSegment(segment: string): number[] | undefined {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) return undefined;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return fields;
}

/**
 * Decodes a source map once into an offset-to-original-line lookup.
 *
 * Each generated line keeps its mapped segments as `[column, sourceLine]`
 * pairs in column order, so a lookup costs a binary search over line starts
 * and one over that line's segments: a page with many findings is mapped in linear time,
 * not once per finding over the whole map. A segment outside Base64 ends the
 * decode with what was read before it.
 *
 * @param mappings - The source map's `mappings` field
 * @param emitted - The emitted code
 * @returns The 1-based original line of an offset into `emitted`, line 1 when unmapped
 */
export function createLineMapper(mappings: string, emitted: string): (offset: number) => number {
  const lineStarts = [0];
  for (let i = 0; i < emitted.length; i++) if (emitted.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const segments: (readonly (readonly [number, number])[])[] = [];
  let sourceLine = 0;
  decode: for (const line of mappings.split(';')) {
    const mapped: (readonly [number, number])[] = [];
    segments.push(mapped);
    let column = 0;
    for (const segment of line.split(',')) {
      if (segment === '') continue;
      const fields = decodeSegment(segment);
      if (fields === undefined) break decode;
      column += fields[0]!;
      // Source-line deltas run across every segment, mapped or not.
      if (fields.length >= 4) {
        sourceLine += fields[2]!;
        mapped.push([column, sourceLine]);
      }
    }
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    const column = offset - lineStarts[low]!;
    // The last mapping at or before the column, by binary search: many findings
    // can share one emitted line (an array literal), so a scan would be quadratic.
    const mapped = segments[low] ?? [];
    let first = 0;
    let last = mapped.length - 1;
    let found: number | undefined;
    while (first <= last) {
      const middle = (first + last) >> 1;
      const [start, line] = mapped[middle]!;
      if (start <= column) {
        found = line;
        first = middle + 1;
      } else last = middle - 1;
    }
    return (found ?? 0) + 1;
  };
}

/**
 * Reports every `fetch` of a path under `/api/` in one emitted page.
 *
 * @param path - The page, project-relative
 * @param emitted - The JavaScript esbuild emitted for it
 * @param mappings - That output's source-map `mappings`
 * @returns The calls, or `unreadable` when the lexer cannot tokenize the output
 */
export function pageApiFetches(
  path: string,
  emitted: string,
  mappings: string,
): readonly PageApiFetch[] | 'unreadable' {
  const calls = lexApiFetches(emitted);
  if (calls === undefined) return 'unreadable';
  const lineOf = createLineMapper(mappings, emitted);
  return calls.map((call) => ({
    path,
    line: lineOf(call.start),
    target: call.target,
  }));
}

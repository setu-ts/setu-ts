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
 * The original line of an offset in esbuild's output, read from its source map.
 *
 * Uses the last mapping on the offset's generated line that starts at or
 * before its column. Falls back to line 1 when the map has none, so a finding
 * is never dropped.
 *
 * @param mappings - The source map's `mappings` field
 * @param emitted - The emitted code
 * @param offset - An offset into `emitted`
 * @returns The 1-based original line
 */
export function originalLineAt(mappings: string, emitted: string, offset: number): number {
  const before = emitted.slice(0, offset);
  const targetLine = before.split('\n').length - 1;
  const targetColumn = offset - (before.lastIndexOf('\n') + 1);
  let sourceLine = 0;
  let found: number | undefined;
  const lines = mappings.split(';');
  for (let line = 0; line < lines.length && line <= targetLine; line++) {
    let column = 0;
    for (const segment of lines[line]!.split(',')) {
      if (segment === '') continue;
      const fields = decodeSegment(segment);
      if (fields === undefined) return (found ?? 0) + 1;
      column += fields[0]!;
      // Source-line deltas run across every segment, mapped or not.
      if (fields.length >= 4) sourceLine += fields[2]!;
      if (line === targetLine && column <= targetColumn && fields.length >= 4) found = sourceLine;
    }
  }
  return (found ?? 0) + 1;
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
  return calls.map((call) => ({
    path,
    line: originalLineAt(mappings, emitted, call.start),
    target: call.target,
  }));
}

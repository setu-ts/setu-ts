/**
 * Re-wrapping generated Markdown prose to the width the project is formatted at.
 *
 * Generated prose used to be hand-wrapped in the template literal that produced
 * it — which works only for the exact values the author happened to interpolate.
 * A `--transport rabbitmq` workspace failed its own `deno fmt --check` on both
 * generated READMEs (X2-4): the root one was wrapped too NARROW because the
 * author had written it around a shorter transport name and URL, and the k8s one
 * was not wrapped at all because the interpolated sentence pushed it past the
 * width. Same defect, opposite directions.
 *
 * Wrapping programmatically removes the class rather than the instance: the
 * output no longer depends on how long an interpolated value happens to be.
 *
 * @module
 */

import { GENERATED_LINE_WIDTH as LINE_WIDTH } from '../templates/root-settings.ts';

/**
 * Re-wraps a paragraph to the generated project's line width.
 *
 * Whitespace-insensitive by design: the input's own line breaks are discarded
 * and the words re-flowed, so a caller may write the source however it reads
 * best in the template literal.
 *
 * A word longer than the remaining width is placed on its own line rather than
 * broken — `deno fmt` does not break a word either, so breaking one here would
 * produce output the formatter immediately rejoins.
 *
 * @param text - The paragraph, with any existing line breaks
 * @param indent - Prefix for every line after the first, e.g. `'  '` for a
 * Markdown list item's continuation
 * @returns The paragraph wrapped to the emitted width
 */
export function wrapProse(text: string, indent = ''): string {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return '';

  const lines: string[] = [];
  let line = words[0] as string;

  for (const word of words.slice(1)) {
    const prefix = lines.length === 0 ? '' : indent;
    if (`${prefix}${line} ${word}`.length > LINE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  lines.push(line);

  return lines.map((entry, index) => (index === 0 ? entry : `${indent}${entry}`)).join('\n');
}

/**
 * Where a CLI edit inserts a new import declaration into developer-owned source.
 *
 * Shared by every editor that adds an import, so the placement rule has one
 * implementation: after the last complete import statement, at the end of its
 * line. PR #524 shipped an editor that spliced an import INSIDE the last
 * multi-line import; finishing the statement first is the fix.
 *
 * @module
 */
import { maskImportDeclarations } from '../devtool/sources.ts';

/**
 * Finds the offset just past the last top-level import statement.
 *
 * @param source - The original text
 * @param visible - `source` with comments masked, position for position
 * @returns The insertion offset (0 when the file has no import), or undefined
 *   when the last import's specifier cannot be read
 */
export function afterLastImport(source: string, visible: string): number | undefined {
  const without = maskImportDeclarations(visible);
  let at = 0;
  for (let i = 0; i < visible.length; i++) if (visible[i] !== without[i]) at = i + 1;
  // maskImportDeclarations blanks only the clause through `from`, not its specifier.
  // Finish that statement before choosing the end of its line as the insertion point.
  if (at > 0) {
    const specifier = /^[ \t]*(?:'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*")[ \t]*;?/.exec(
      visible.slice(at),
    );
    if (specifier === null) return undefined;
    at += specifier[0].length;
    const lineEnd = source.indexOf('\n', at);
    at = lineEnd < 0 ? source.length : lineEnd;
  }
  // Side-effect imports carry no `from` clause, but can still be the last import.
  for (const match of visible.matchAll(
    /^[ \t]*import[ \t]*(?:'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*")[^\r\n]*/gm,
  )) {
    at = Math.max(at, match.index + match[0].length);
  }
  return at;
}

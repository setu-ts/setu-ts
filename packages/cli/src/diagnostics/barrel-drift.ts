/** Set-based inspection of managed registration barrels. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { SeamArtifacts, SeamSpec } from '../seams/seam-spec.ts';
import { maskComments, maskSourceCode } from '../devtool/sources.ts';
import { joinPath, MAX_EXISTING_FILE_BYTES } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import type { Finding } from './diagnose.ts';

/** Reads only regular, bounded files; absence and unsafe evidence stay distinct. */
export async function readBarrel(
  fs: IFileSystem,
  path: string,
): Promise<
  | { readonly kind: 'absent' }
  | { readonly kind: 'source'; readonly source: string }
  | { readonly kind: 'unreadable'; readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable' }
> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile) return { kind: 'unreadable', reason: 'not-a-file' };
    if (stat.size > MAX_EXISTING_FILE_BYTES) return { kind: 'unreadable', reason: 'too-large' };
    return { kind: 'source', source: new TextDecoder().decode(await fs.readFile(path)) };
  } catch (cause) {
    return isMissingPath(cause)
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: 'unclassifiable' };
  }
}

const WHITESPACE = /\s/;
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[\w$]/;

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char);
}

/**
 * For every index, the position of the next character in `stops` at or after it
 * (`-1` when none). Built once, right to left, so a lookup is constant time:
 * the parser below never rescans text to find a closing brace or quote.
 */
function nextStops(text: string, stops: string): Int32Array {
  const next = new Int32Array(text.length + 1).fill(-1);
  for (let index = text.length - 1; index >= 0; index--)
    next[index] = stops.includes(text.charAt(index)) ? index : (next[index + 1] ?? -1);
  return next;
}

/** Whether a keyword at `at` begins a statement: preceded by start, `;` or a line break. */
function atStatementStart(text: string, at: number): boolean {
  let index = at - 1;
  for (; index >= 0 && isWhitespace(text[index]); index--)
    if (text[index] === '\n' || text[index] === '\r') return true;
  return index < 0 || text[index] === ';';
}

/**
 * Lists the module specifiers of a barrel's `import … from` and `export … from`
 * declarations, in linear time.
 *
 * `setu check` runs in CI over files a pull request controls, so a parse that
 * backtracks is a denial of service: the regular expression this replaces took
 * minutes on a 1 MiB barrel of blank lines (M118 audit F1). Keywords are found
 * once in the string-masked view (`code`); each declaration is then read forward
 * from its keyword with one token step at a time, and a closing brace or quote is
 * a table lookup. A brace list may not contain `{` or `;` — no import list does —
 * which is what keeps each `{` resolving to at most one `}`.
 *
 * @param source - The barrel with comments masked (string literals kept)
 * @param code - The same text with strings masked too, the same length
 * @returns The specifiers, in source order
 */
export function declarationSpecifiers(source: string, code: string): readonly string[] {
  const braceStop = nextStops(source, '{};');
  const quoteStop = nextStops(source, '\'"\r\n');
  const skip = (from: number): number => {
    let index = from;
    while (isWhitespace(source[index])) index++;
    return index;
  };
  // At least one whitespace character, as `\s+` required; -1 when there is none.
  const skipSome = (from: number): number => (isWhitespace(source[from]) ? skip(from) : -1);
  const identifierEnd = (from: number): number => {
    if (!IDENTIFIER_START.test(source.charAt(from))) return -1;
    let index = from + 1;
    while (IDENTIFIER_PART.test(source.charAt(index))) index++;
    return index;
  };
  const braceEnd = (from: number): number => {
    const close = braceStop[from + 1] ?? -1;
    return source[from] === '{' && close >= 0 && source[close] === '}' ? close + 1 : -1;
  };
  const namespaceEnd = (from: number): number => {
    const as = skipSome(from + 1);
    if (as < 0 || !source.startsWith('as', as)) return -1;
    const name = skipSome(as + 2);
    return name < 0 ? -1 : identifierEnd(name);
  };
  // Every way the clause after the keyword can end, as the alternation could.
  const clauseEnds = (from: number): readonly number[] => {
    if (source[from] === '{') return [braceEnd(from)];
    if (source[from] === '*') return [namespaceEnd(from), from + 1];
    const name = identifierEnd(from);
    if (name < 0) return [];
    const comma = skip(name);
    if (source[comma] !== ',') return [name];
    const next = skip(comma + 1);
    return [
      source[next] === '{' ? braceEnd(next) : source[next] === '*' ? namespaceEnd(next) : -1,
      name,
    ];
  };
  const specifier = (from: number): string | undefined => {
    const keyword = skipSome(from);
    if (keyword < 0 || !source.startsWith('from', keyword)) return undefined;
    const open = skip(keyword + 4);
    const quote = source[open];
    if (quote !== "'" && quote !== '"') return undefined;
    const close = quoteStop[open + 1] ?? -1;
    return close > open + 1 && source[close] === quote ? source.slice(open + 1, close) : undefined;
  };
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:import|export)\b/g)) {
    if (!atStatementStart(source, match.index)) continue;
    const clause = skipSome(match.index + match[0].length);
    if (clause < 0) continue;
    // `type` is a modifier only when a clause follows it; `import type from` names `type`.
    const typed = source.startsWith('type', clause) ? skipSome(clause + 4) : -1;
    const starts = typed >= 0 ? [typed, clause] : [clause];
    const resolved = starts
      .flatMap(clauseEnds)
      .filter((end) => end >= 0)
      .map(specifier)
      .find((value) => value !== undefined);
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

/** Compares import/export specifier name sets, merging families sharing a barrel. */
export async function diagnoseBarrels(
  fs: IFileSystem,
  dir: string,
  specs: readonly SeamSpec[],
  artifacts: SeamArtifacts,
): Promise<readonly Finding[]> {
  const groups = new Map<string, SeamSpec[]>();
  for (const spec of specs) {
    if (spec.exports.length === 0) continue;
    groups.set(spec.barrel, [...(groups.get(spec.barrel) ?? []), spec]);
  }
  const findings: Finding[] = [];
  for (const [barrel, families] of groups) {
    const read = await readBarrel(fs, joinPath(dir, barrel));
    if (read.kind === 'unreadable') {
      findings.push({ kind: 'barrel-unreadable', barrel, reason: read.reason });
      continue;
    }
    const source = read.kind === 'absent' ? '' : maskComments(read.source);
    if (source === undefined) {
      findings.push({ kind: 'barrel-unreadable', barrel, reason: 'unclassifiable' });
      continue;
    }
    // Keep specifier literals for parsing, but require each declaration keyword
    // to occupy code in the string-masked view as well. A semicolon inside a
    // string must not turn import-looking prose into a stale artifact.
    const code = maskSourceCode(source) ?? '';
    const imports = declarationSpecifiers(source, code);
    const unlisted = new Set<string>();
    const stale = new Set<string>();
    for (const family of families) {
      const admitted = new Set(artifacts[family.schematic] ?? []);
      const listed = new Set(
        imports
          .filter(
            (path) =>
              path.startsWith('./') &&
              path.endsWith(family.suffix) &&
              path.length > family.suffix.length + 2,
          )
          .map((path) => path.slice(2, -family.suffix.length)),
      );
      for (const name of admitted)
        if (!listed.has(name)) unlisted.add(joinPath(family.dir, `${name}${family.suffix}`));
      for (const name of listed)
        if (!admitted.has(name)) stale.add(joinPath(family.dir, `${name}${family.suffix}`));
    }
    if (unlisted.size > 0 || stale.size > 0)
      findings.push({
        kind: 'barrel-drift',
        barrel,
        unlisted: [...unlisted].sort(),
        stale: [...stale].sort(),
      });
  }
  return findings;
}

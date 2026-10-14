// Converts deno lint suppression comments to ESLint's (M111e1 §3.3).
// Usage: node scripts/codemods/deno-lint-ignore-to-eslint.ts [--write] [files...]
/* eslint-disable no-console -- repository command-line tooling */
// Without file arguments it reads every tracked .ts/.tsx/.js/.mjs file. Without --write it reports
// what it would change. A rule with no mapping is refused by file and line, never guessed.
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** deno lint rule → ESLint rule. `null` drops the rule: ESLint has its own unused-directive check. */
export const RULE_MAP: Readonly<Record<string, string | null>> = {
  'require-await': 'require-await',
  'no-explicit-any': '@typescript-eslint/no-explicit-any',
  'no-console': 'no-console',
  'no-control-regex': 'no-control-regex',
  'no-unused-vars': '@typescript-eslint/no-unused-vars',
  'no-this-alias': '@typescript-eslint/no-this-alias',
  // Every ban-types site in the tree types a bare `Function` (M111e1 §3.3).
  'ban-types': '@typescript-eslint/no-unsafe-function-type',
  'ban-unused-ignore': null,
};

/** One problem that stopped a file from being converted. */
export interface Refusal {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/** The outcome of converting one source text. */
export interface Conversion {
  /** The converted text; identical to the input when nothing applied or anything was refused. */
  readonly text: string;
  /** How many directives were rewritten. */
  readonly converted: number;
  readonly refusals: readonly Refusal[];
}

const DIRECTIVE = /^\/\/\s*deno-lint-ignore(-file)?(?=\s|$)(.*)$/;

/**
 * Rewrites the deno lint directives in one source text. Only a single-line comment that BEGINS
 * with a directive is converted, so the same words in a string or in prose are left alone.
 *
 * @param file - The file name, used in refusals.
 * @param source - The source text.
 * @returns The converted text, or the original text and the refusals.
 */
export function convertSource(file: string, source: string): Conversion {
  const edits: { start: number; end: number; text: string }[] = [];
  const refusals: Refusal[] = [];
  for (const range of commentRanges(file, source)) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const match = DIRECTIVE.exec(source.slice(range.pos, range.end));
    if (match === null) continue;
    const line = source.slice(0, range.pos).split('\n').length;
    const rewritten = rewrite(match[1] !== undefined, match[2] ?? '');
    if (typeof rewritten === 'string') {
      edits.push({ start: range.pos, end: range.end, text: rewritten });
    } else {
      refusals.push({ file, line, detail: rewritten.refusal });
    }
  }
  if (refusals.length > 0) return { text: source, converted: 0, refusals };
  let text = source;
  for (const edit of edits.reverse()) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text, converted: edits.length, refusals };
}

/**
 * Every comment in the file, in source order, found from a real parse. A bare scanner loses sync
 * after a regular expression or a template literal (only the parser rescans those), which would
 * skip the comments after one and could read string content as a comment.
 */
function commentRanges(file: string, source: string): ts.CommentRange[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const found = new Map<number, ts.CommentRange>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    node.forEachChild(visit);
  };
  visit(tree);
  collect(ts.getLeadingCommentRanges(source, tree.endOfFileToken.pos));
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

function rewrite(fileLevel: boolean, rest: string): string | { refusal: string } {
  const separator = rest.indexOf('--');
  const ruleText = separator === -1 ? rest : rest.slice(0, separator);
  const reason = separator === -1 ? '' : rest.slice(separator + 2).trim();
  const names = ruleText.split(/[\s,]+/).filter((name) => name !== '');
  if (names.length === 0) {
    return { refusal: 'a directive naming no rule would become a blanket disable' };
  }
  const mapped: string[] = [];
  for (const name of names) {
    if (!Object.hasOwn(RULE_MAP, name)) return { refusal: `no ESLint mapping for '${name}'` };
    const target = RULE_MAP[name];
    if (target !== null && target !== undefined && !mapped.includes(target)) mapped.push(target);
  }
  if (mapped.length === 0) return { refusal: 'every rule named is dropped; delete the directive' };
  const suffix = reason === '' ? '' : ` -- ${reason}`;
  if (!fileLevel) return `// eslint-disable-next-line ${mapped.join(', ')}${suffix}`;
  if (suffix.includes('*/')) return { refusal: "a reason containing '*/' cannot sit in a block" };
  return `/* eslint-disable ${mapped.join(', ')}${suffix} */`;
}

/** Every tracked source file ESLint will lint. */
export function trackedSources(cwd = '.'): string[] {
  const output = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.mjs'], {
    cwd,
    encoding: 'utf8',
  });
  return output.split('\n').filter((file) => file !== '');
}

/**
 * The command: converts the named files (or every tracked source), reporting refusals.
 *
 * @param args - Command-line arguments: `--write` and optional file paths.
 * @param log - Receives one line per converted file and per refusal.
 * @returns The exit code: 1 when anything was refused, else 0.
 */
export function main(args: readonly string[], log: (line: string) => void): number {
  const write = args.includes('--write');
  const named = args.filter((arg) => !arg.startsWith('--'));
  const files = named.length > 0 ? named : trackedSources();
  let refused = 0;
  for (const file of files) {
    const result = convertSource(file, readFileSync(file, 'utf8'));
    for (const refusal of result.refusals) {
      log(`${refusal.file}:${refusal.line}: ${refusal.detail}`);
      refused++;
    }
    if (result.converted === 0) continue;
    log(`${write ? 'converted' : 'would convert'} ${result.converted} in ${file}`);
    if (write) writeFileSync(file, result.text);
  }
  return refused > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2), (line) => console.log(line));
}

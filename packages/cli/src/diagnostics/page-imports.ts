/**
 * `setu.E017` page-kernel-value-import (M130 §3.7): a module under `app/` that
 * imports kernel code (`~kernel/…`, or a relative path into `src/`) by value.
 *
 * Pages may import kernel TYPES and token modules only. A type import is erased
 * before bundling, and a `*.token.ts` module holds a string constant; anything
 * else would carry server code into the client bundle. This is the one check
 * every runtime runs: the generated `check` script calls `setu check` on Node,
 * Deno and Bun, and Deno projects have no ESLint.
 *
 * The page is first transformed by esbuild exactly as the bundle sees it (the
 * `tsx` loader with `verbatimModuleSyntax`): JSX and types are gone, `import
 * type` / `export type` are erased, and `import { type A }` survives as the
 * side-effect `import {} from …`. The shared import lexer then reads that plain
 * JavaScript, so JSX text such as \`it's\` cannot be mistaken for a string. Each
 * finding is mapped back to the line of the specifier in the original source. A
 * file esbuild or the lexer cannot read is reported rather than passed: a misread
 * is a finding the user can silence, never a silent pass.
 *
 * @module
 */

import { transform } from 'esbuild';
import type { IFileSystem } from '@setu-ts/common';
import { lexImportSpecifiers, type ISpecifierSpan } from '../utils/import-specifiers.ts';
import { maskComments } from '../devtool/sources.ts';
import { normalizeRelative } from '../utils/artifact-path.ts';
import { joinPath, MAX_EXISTING_FILE_BYTES } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';

/** Why a page import is refused. */
export type PageImportReason =
  'value-import' | 'inline-type-only' | 'export-star' | 'dynamic' | 'glob';

/** One refused import, with the line it starts on. */
export interface PageImportViolation {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: PageImportReason;
}

/** The kernel alias every page reaches kernel code through. */
const KERNEL_ALIAS = '~kernel/';

/** The template's page alias, `~/*` → `app/*`; `~/../src/…` climbs out of it. */
const PAGE_ALIAS = '~/';

/** A token module: the one value import a page may make from the kernel. */
const TOKEN_MODULE = /^src\/modules\/[^/]+\/[^/]+\.token\.ts$/;

/** Files under `app/` a page can be written in, and the esbuild loader for each. */
const PAGE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** The esbuild loader for a page file. */
function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.jsx')) return 'jsx';
  return /\.[cm]?ts$/.test(path) ? 'ts' : 'js';
}

/**
 * Resolves a specifier to a normalised project-relative path, or undefined for a
 * package specifier. Every spelling the bundler resolves is followed: the
 * `~kernel/` and `~/` aliases, the project's own absolute path (plain or behind
 * Vite's `/@fs`), a root-absolute path (Vite's project root), and a relative
 * path. A `?query` or `#hash` suffix, which Vite strips, is dropped first. The
 * result starts with `..` when the path leaves the project.
 */
function resolveSpecifier(file: string, specifier: string, root?: string): string | undefined {
  let bare = specifier.replace(/[?#][\s\S]*$/, '');
  if (bare.startsWith('/@fs/')) bare = bare.slice('/@fs'.length);
  let path: string;
  if (bare.startsWith(KERNEL_ALIAS)) path = `src/${bare.slice(KERNEL_ALIAS.length)}`;
  else if (bare.startsWith(PAGE_ALIAS)) path = `app/${bare.slice(PAGE_ALIAS.length)}`;
  else if (root !== undefined && (bare === root || bare.startsWith(`${root}/`)))
    path = bare.slice(root.length);
  else if (bare.startsWith('/')) path = bare.slice(1);
  else if (bare.startsWith('./') || bare.startsWith('../')) {
    const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    path = `${base}/${bare}`;
  } else return undefined;
  return normalizeRelative(path);
}

/**
 * Resolves a specifier to its project-relative kernel target, or undefined when
 * it does not reach `src/`. A `~kernel/` specifier always counts as kernel, even
 * one whose dot segments climb out of `src/`: it is reported, never passed.
 *
 * @param file - The importing file, project-relative
 * @param specifier - The import specifier
 * @param root - The project's absolute directory, when known
 * @returns The target under `src/`, or undefined
 */
export function kernelTarget(file: string, specifier: string, root?: string): string | undefined {
  const resolved = resolveSpecifier(file, specifier, root);
  if (resolved === undefined) return undefined;
  if (resolved === 'src' || resolved.startsWith('src/')) return resolved;
  return specifier.startsWith(KERNEL_ALIAS)
    ? `src/${specifier.slice(KERNEL_ALIAS.length)}`
    : undefined;
}

/**
 * Reports whether an `import.meta.glob` pattern can match a file under `src/`:
 * its literal directory prefix, after the call's `base` option, is `src/`,
 * inside it, or an ancestor of it (including any path that leaves the project).
 * A negative (`!`) pattern only excludes files, so it never reaches anything.
 *
 * @param file - The importing file, project-relative
 * @param pattern - One glob pattern
 * @param base - The call's literal `base` option, if any
 * @param root - The project's absolute directory, when known
 * @returns Whether the pattern reaches kernel code
 */
export function globReachesKernel(
  file: string,
  pattern: string,
  base?: string,
  root?: string,
): boolean {
  if (pattern.startsWith('!')) return false;
  const relative = !/^(?:\/|~)/.test(pattern);
  const anchored =
    base !== undefined && relative
      ? `${/^(?:\.\.?\/|\/|~)/.test(base) ? base : `./${base}`}/${pattern}`
      : pattern;
  const wild = anchored.search(/[*?{[]/);
  const literal = wild < 0 ? anchored : anchored.slice(0, wild);
  const dir = literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/') + 1) : './';
  const resolved = resolveSpecifier(file, /^(?:\.\.?\/|\/|~)/.test(dir) ? dir : `./${dir}`, root);
  if (resolved === undefined) return false;
  return (
    resolved === '' ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    resolved === 'src' ||
    resolved.startsWith('src/')
  );
}

/** `import.meta.glob(` calls, with whatever follows the opening parenthesis. */
const GLOB_CALL = /import\.meta\.glob\s*\(\s*/g;

/** One string literal, or an array of them, as a glob's first argument. */
const GLOB_LITERAL =
  /^(?:(["'`])((?:(?!\1)[^\\$])*)\1|\[((?:\s*(["'])(?:(?!\4)[^\\])*\4\s*,?)*)\s*\])/;

/** A `base` key with a literal string value, in a glob's options object. */
const GLOB_BASE = /(?:["']base["']|\bbase)\s*:\s*(?:(["'`])((?:(?!\1)[^\\$])*)\1)?/;

/**
 * Blanks every string, template and comment body in emitted JavaScript, keeping
 * offsets, so a code pattern found in the result is code: JSX text and string
 * literals that merely mention `import.meta.glob` are not calls.
 */
export function maskLiterals(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

/** One glob call: its patterns and its literal `base` option, if any. */
interface GlobCall {
  readonly patterns: readonly string[];
  readonly base?: string;
}

/**
 * The patterns and `base` of every `import.meta.glob` call in the emitted
 * source, or `unreadable` when a call's patterns or options are not literals the
 * scan can read (an identifier, a spread, a computed `base`).
 */
function globCalls(emitted: string): readonly GlobCall[] | 'unreadable' {
  const masked = maskLiterals(emitted);
  const calls: GlobCall[] = [];
  for (const match of masked.matchAll(GLOB_CALL)) {
    const at = match.index + match[0].length;
    const literal = GLOB_LITERAL.exec(emitted.slice(at));
    if (literal === null) return 'unreadable';
    const patterns =
      literal[2] !== undefined
        ? [literal[2]]
        : [...(literal[3] ?? '').matchAll(/(["'])((?:(?!\1)[^\\])*)\1/g)].map((m) => m[2]!);
    const after = at + literal[0].length;
    const next = /^\s*(,\s*)?(\)|\{)?/.exec(masked.slice(after))!;
    if (next[2] === ')' || (next[1] === undefined && next[2] === undefined)) {
      calls.push({ patterns });
      continue;
    }
    if (next[2] !== '{') return 'unreadable';
    const open = after + next[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < masked.length; close++) {
      if (masked[close] === '{') depth++;
      else if (masked[close] === '}' && --depth === 0) break;
    }
    const options = emitted.slice(open, close + 1);
    if (masked.slice(open, close + 1).includes('...')) return 'unreadable';
    const base = GLOB_BASE.exec(options);
    if (base === null) calls.push({ patterns });
    else if (base[2] === undefined) return 'unreadable';
    else calls.push({ patterns, base: base[2] });
  }
  return calls;
}

/** The text of the statement a static specifier belongs to, from its keyword. */
function statementHead(source: string, span: ISpecifierSpan): string {
  const before = source.slice(0, span.start);
  const keyword = Math.max(before.lastIndexOf('import'), before.lastIndexOf('export'));
  return keyword < 0 ? '' : before.slice(keyword);
}

/**
 * Classifies one kernel import as it survives into the bundle.
 *
 * @param emitted - The esbuild output
 * @param span - The lexed specifier in that output
 * @param target - Its project-relative kernel target
 * @returns The refusal reason, or undefined when the import is allowed
 */
function classify(
  emitted: string,
  span: ISpecifierSpan,
  target: string,
): PageImportReason | undefined {
  if (span.kind === 'dynamic') return 'dynamic';
  const head = statementHead(emitted, span);
  if (/^export\s*\*/.test(head)) return 'export-star';
  if (TOKEN_MODULE.test(target)) return undefined;
  // `import { type A }` is emitted as `import {} from …`: no binding, but the
  // declaration survives and loads the module.
  if (/^import\s*\{\s*\}\s*from\s*$/.test(head)) return 'inline-type-only';
  return 'value-import';
}

/**
 * The line of the `occurrence`-th quoted use of `specifier` in the original
 * source, comments masked. Falls back to line 1 when it cannot be found (a
 * specifier esbuild normalised), so a finding is never dropped.
 */
function originalLine(source: string, specifier: string, occurrence: number): number {
  const visible = maskComments(source) ?? source;
  let seen = 0;
  for (let i = 0; i < visible.length; i++) {
    const quote = visible[i];
    if (quote !== "'" && quote !== '"') continue;
    if (visible.startsWith(`${specifier}${quote}`, i + 1)) {
      if (seen === occurrence) {
        let line = 1;
        for (let j = 0; j < i; j++) if (visible.charCodeAt(j) === 10) line++;
        return line;
      }
      seen++;
    }
  }
  return 1;
}

/**
 * Reports every refused kernel import in one page source.
 *
 * @param path - The page, project-relative
 * @param source - Its contents
 * @param root - The project's absolute directory, so an absolute import into it resolves
 * @returns The violations, or `unreadable` when esbuild or the lexer refuses the file
 */
export async function scanPageSource(
  path: string,
  source: string,
  root?: string,
): Promise<readonly PageImportViolation[] | 'unreadable'> {
  let emitted: string;
  try {
    emitted = (
      await transform(source, {
        loader: loaderFor(path),
        format: 'esm',
        jsx: 'automatic',
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      })
    ).code;
  } catch {
    return 'unreadable';
  }
  const lexed = lexImportSpecifiers(emitted);
  if (lexed.kind !== 'ok') return 'unreadable';
  const violations: PageImportViolation[] = [];
  const occurrences = new Map<string, number>();
  for (const span of lexed.spans) {
    const target = kernelTarget(path, span.value, root);
    if (target === undefined) continue;
    const occurrence = occurrences.get(span.value) ?? 0;
    occurrences.set(span.value, occurrence + 1);
    const reason = classify(emitted, span, target);
    if (reason !== undefined)
      violations.push({
        path,
        line: originalLine(source, span.value, occurrence),
        specifier: span.value,
        reason,
      });
  }
  const globs = globCalls(emitted);
  if (globs === 'unreadable') return 'unreadable';
  const used = new Set<number>();
  for (const call of globs) {
    const reaching = call.patterns.find((pattern) =>
      globReachesKernel(path, pattern, call.base, root),
    );
    if (reaching !== undefined)
      violations.push({
        path,
        line: globLine(source, reaching, used),
        specifier: reaching,
        reason: 'glob',
      });
  }
  return violations;
}

/**
 * The line of the first not-yet-reported `import.meta.glob` in the original
 * source whose call names `pattern`, comments masked. Line 1 when none is
 * found, so a finding is never dropped.
 */
function globLine(source: string, pattern: string, used: Set<number>): number {
  const visible = maskComments(source) ?? source;
  for (const call of visible.matchAll(GLOB_CALL)) {
    const window = visible.slice(call.index, call.index + 4096);
    if (used.has(call.index) || !window.includes(pattern)) continue;
    used.add(call.index);
    let line = 1;
    for (let j = 0; j < call.index; j++) if (visible.charCodeAt(j) === 10) line++;
    return line;
  }
  return 1;
}

/**
 * Directory levels below `app/` the walk descends. Route trees are shallow; the
 * bound exists so a symlinked directory loop ends instead of recursing forever.
 */
const MAX_PAGE_DEPTH = 32;

/**
 * Collects every page file under `app/`, sorted. A page over
 * {@linkcode MAX_EXISTING_FILE_BYTES}, or a directory past
 * {@linkcode MAX_PAGE_DEPTH}, is collected as unreadable rather than read or
 * skipped, so neither becomes a silent pass.
 */
async function pageFiles(
  fs: IFileSystem,
  dir: string,
  prefix: string,
  depth = 0,
): Promise<{ readonly pages: string[]; readonly unreadable: string[] }> {
  let entries: readonly string[];
  try {
    entries = await fs.readdir(joinPath(dir, prefix));
  } catch (cause) {
    if (isMissingPath(cause)) return { pages: [], unreadable: [] };
    throw cause;
  }
  const pages: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}/${entry}`;
    const stat = await fs.stat(joinPath(dir, relative));
    if (stat.isDirectory) {
      if (depth >= MAX_PAGE_DEPTH) {
        unreadable.push(relative);
        continue;
      }
      const nested = await pageFiles(fs, dir, relative, depth + 1);
      pages.push(...nested.pages);
      unreadable.push(...nested.unreadable);
    } else if (stat.isFile && PAGE_FILE.test(entry)) {
      (stat.size > MAX_EXISTING_FILE_BYTES ? unreadable : pages).push(relative);
    }
  }
  return { pages: pages.sort(), unreadable: unreadable.sort() };
}

/** The result of scanning a project's pages. */
export interface PageImportScan {
  readonly violations: readonly PageImportViolation[];
  /** Pages the lexer could not read, reported rather than passed. */
  readonly unreadable: readonly string[];
}

/**
 * Scans every `app/**\/*.{ts,tsx}` for kernel value imports. A project without
 * `app/` has no pages and yields nothing.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project root
 * @returns The violations and the unreadable pages
 */
export async function scanPageImports(fs: IFileSystem, dir: string): Promise<PageImportScan> {
  const violations: PageImportViolation[] = [];
  const found = await pageFiles(fs, dir, 'app');
  const unreadable: string[] = [...found.unreadable];
  const decoder = new TextDecoder();
  for (const path of found.pages) {
    const result = await scanPageSource(
      path,
      decoder.decode(await fs.readFile(joinPath(dir, path))),
      dir.replace(/\/+$/, ''),
    );
    if (result === 'unreadable') unreadable.push(path);
    else violations.push(...result);
  }
  return { violations, unreadable };
}

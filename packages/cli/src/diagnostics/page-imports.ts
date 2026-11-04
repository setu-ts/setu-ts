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

/**
 * A token module: the one value import a page may make from the kernel, written
 * with its `.ts` extension, its emitted `.js` one, or none. The last two are
 * accepted only when they resolve to the `.token.ts` file (see
 * {@linkcode TokenResolver}).
 */
const TOKEN_MODULE = /^src\/modules\/[^/]+\/[^/]+\.token(?:\.[jt]s)?$/;

/**
 * Reports whether a token import written without `.ts` (`x.token` or
 * `x.token.js`) resolves to `x.token.ts`, as the bundler and type-checker see
 * it. Without one, such an import is accepted on its spelling alone.
 */
export type TokenResolver = (target: string) => Promise<boolean>;

/**
 * Files the bundler tries before `x.token.ts` for each spelling: Vite tries the
 * exact path, then `.mjs`, `.js` and `.mts` before `.ts`; for a `.js` spelling,
 * an existing `.js` file wins over the `.ts` it would otherwise map to.
 */
function tokenShadows(target: string): {
  readonly stem: string;
  readonly before: readonly string[];
} {
  if (target.endsWith('.js')) {
    const stem = target.slice(0, -'.js'.length);
    return { stem, before: [target] };
  }
  return { stem: target, before: [target, `${target}.mjs`, `${target}.js`, `${target}.mts`] };
}

/**
 * The {@linkcode TokenResolver} over a project's filesystem: `x.token.ts` is a
 * file and nothing the bundler tries first exists.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project root
 * @returns The resolver
 */
function tokenResolverFor(fs: IFileSystem, dir: string): TokenResolver {
  const kind = async (path: string): Promise<'file' | 'directory' | 'missing' | 'unknown'> => {
    try {
      const stat = await fs.stat(joinPath(dir, path));
      return stat.isFile ? 'file' : stat.isDirectory ? 'directory' : 'unknown';
    } catch (cause) {
      return isMissingPath(cause) ? 'missing' : 'unknown';
    }
  };
  return async (target) => {
    const { stem, before } = tokenShadows(target);
    if ((await kind(`${stem}.ts`)) !== 'file') return false;
    for (const path of before) {
      // A directory is passed over for the next candidate; a file wins, and a
      // path that cannot be read may be one, so either refuses the import.
      const found = await kind(path);
      if (found === 'file' || found === 'unknown') return false;
    }
    return true;
  };
}

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

/** `import.meta.glob(` texts in the original source, to map a call to its line. */
const GLOB_CALL = /import\.meta\.glob\s*\(\s*/g;

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
): PageImportReason | 'token-spelling' | undefined {
  if (span.kind === 'dynamic') return 'dynamic';
  const head = statementHead(emitted, span);
  if (/^export\s*\*/.test(head)) return 'export-star';
  if (TOKEN_MODULE.test(target)) return target.endsWith('.token.ts') ? undefined : 'token-spelling';
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
 * @param resolveToken - Checks a token import written without `.ts`
 * @returns The violations, or `unreadable` when esbuild or the lexer refuses the file
 */
export async function scanPageSource(
  path: string,
  source: string,
  root?: string,
  resolveToken?: TokenResolver,
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
    const classified = classify(emitted, span, target);
    const reason =
      classified !== 'token-spelling'
        ? classified
        : resolveToken === undefined || (await resolveToken(target))
          ? undefined
          : 'value-import';
    if (reason !== undefined)
      violations.push({
        path,
        line: originalLine(source, span.value, occurrence),
        specifier: span.value,
        reason,
      });
  }
  if (lexed.globs === 'unreadable') return 'unreadable';
  const calls = [...(maskComments(source) ?? source).matchAll(GLOB_CALL)];
  lexed.globs.forEach((call, index) => {
    const reaching = call.patterns.find((pattern) =>
      globReachesKernel(path, pattern, call.base, root),
    );
    if (reaching !== undefined)
      violations.push({
        path,
        line: globLine(source, calls, index, lexed.globs.length),
        specifier: reaching,
        reason: 'glob',
      });
  });
  return violations;
}

/**
 * The line of the `index`-th glob call. Calls are matched to the original
 * source by position when it shows exactly as many `import.meta.glob(` texts
 * as esbuild's output has calls; otherwise (one mentioned in JSX text, say) the
 * finding is reported on line 1 rather than on a wrong line.
 */
function globLine(
  source: string,
  calls: readonly RegExpExecArray[],
  index: number,
  count: number,
): number {
  if (calls.length !== count) return 1;
  const at = calls[index]!.index;
  let line = 1;
  for (let j = 0; j < at; j++) if (source.charCodeAt(j) === 10) line++;
  return line;
}

/**
 * Directory levels below `app/` the walk descends. Route trees are shallow; the
 * bound exists so a symlinked directory loop ends instead of recursing forever.
 */
const MAX_PAGE_DEPTH = 32;

/**
 * Directories one walk reads. Without `realPath` a directory reached twice
 * through symlinks cannot be recognised, so several link loops multiply the
 * walk; this bound ends it whatever the links do.
 */
const MAX_PAGE_DIRECTORIES = 4096;

/** One walk's state: what it has seen and what it has collected so far. */
interface PageWalk {
  readonly fs: IFileSystem;
  readonly dir: string;
  readonly seen: Set<string>;
  readonly pages: string[];
  readonly unreadable: string[];
  directories: number;
  appReal?: string;
}

/**
 * Resolves a path through `realPath` and reports whether it stays inside
 * `app/`; the first path resolved is `app/` itself. Returns 'missing' for a
 * path that is gone and 'outside' for one that cannot be resolved or that a
 * symlink places outside `app/`.
 */
async function realInsideApp(
  walk: PageWalk,
  realPath: NonNullable<IFileSystem['realPath']>,
  path: string,
): Promise<string | 'missing' | 'outside'> {
  let real: string;
  try {
    real = await realPath(path);
  } catch (cause) {
    return isMissingPath(cause) ? 'missing' : 'outside';
  }
  walk.appReal ??= real;
  return real === walk.appReal || real.startsWith(`${walk.appReal}/`) ? real : 'outside';
}

/**
 * Collects every page file under `app/` into the walk. Anything the walk cannot
 * read safely is collected as unreadable (E018) rather than read or skipped, so
 * none becomes a silent pass: a page over {@linkcode MAX_EXISTING_FILE_BYTES}, a
 * directory past {@linkcode MAX_PAGE_DEPTH} or beyond
 * {@linkcode MAX_PAGE_DIRECTORIES}, a directory or page a symlink places outside
 * `app/`, and an entry whose `stat` or `readdir` fails (`ELOOP`, `EACCES`). With
 * `realPath` available a directory reached twice through symlinks is walked
 * once, so a link loop costs one visit; without it the directory bound ends the
 * walk.
 */
async function pageFiles(walk: PageWalk, prefix: string, depth = 0): Promise<void> {
  const { fs, dir } = walk;
  const path = joinPath(dir, prefix);
  if (walk.directories >= MAX_PAGE_DIRECTORIES) {
    walk.unreadable.push(prefix);
    return;
  }
  walk.directories += 1;
  if (fs.realPath !== undefined) {
    const real = await realInsideApp(walk, fs.realPath.bind(fs), path);
    if (real === 'missing') return;
    if (real === 'outside') {
      walk.unreadable.push(prefix);
      return;
    }
    if (walk.seen.has(real)) return;
    walk.seen.add(real);
  }
  let entries: readonly string[];
  try {
    entries = await fs.readdir(path);
  } catch (cause) {
    if (!isMissingPath(cause)) walk.unreadable.push(prefix);
    return;
  }
  for (const entry of entries) {
    const relative = `${prefix}/${entry}`;
    let stat: Awaited<ReturnType<IFileSystem['stat']>>;
    try {
      stat = await fs.stat(joinPath(dir, relative));
    } catch {
      walk.unreadable.push(relative);
      continue;
    }
    if (stat.isDirectory) {
      if (depth >= MAX_PAGE_DEPTH) walk.unreadable.push(relative);
      else await pageFiles(walk, relative, depth + 1);
    } else if (stat.isFile && PAGE_FILE.test(entry)) {
      // A page file linked from outside `app/` is bundled like any other, so it
      // is resolved too: one that leaves `app/` is reported, never scanned as a page.
      const outside =
        fs.realPath !== undefined &&
        (await realInsideApp(walk, fs.realPath.bind(fs), joinPath(dir, relative))) === 'outside';
      (outside || stat.size > MAX_EXISTING_FILE_BYTES ? walk.unreadable : walk.pages).push(
        relative,
      );
    }
  }
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
  const walk: PageWalk = { fs, dir, seen: new Set(), pages: [], unreadable: [], directories: 0 };
  await pageFiles(walk, 'app');
  const unreadable = walk.unreadable.sort();
  const decoder = new TextDecoder();
  const resolveToken = tokenResolverFor(fs, dir);
  for (const path of walk.pages.sort()) {
    const result = await scanPageSource(
      path,
      decoder.decode(await fs.readFile(joinPath(dir, path))),
      dir.replace(/\/+$/, ''),
      resolveToken,
    );
    if (result === 'unreadable') unreadable.push(path);
    else violations.push(...result);
  }
  return { violations, unreadable };
}

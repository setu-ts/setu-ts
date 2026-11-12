/** Worker task discovery and per-output URL relocation for Node bundles. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { Plugin } from 'esbuild';
import { assertInsideProject, dirName, resolveDir } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';

async function sourceText(fs: IFileSystem, file: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await fs.readFile(file));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

interface ITaskReference {
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

interface ICodeView {
  /** The source with comments, regex bodies and template text blanked, same length. */
  readonly code: string;
  /** The source with only comments and regex bodies blanked: template text kept. */
  readonly text: string;
  /** Quoted string literals, kept in `code`. */
  readonly strings: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Splits a module into what executes and what does not, in one linear pass
 * (CodeRabbit #582: a regex pass per construct kept missing combinations).
 * Comments, regex literal bodies and template text become spaces; quoted
 * strings are kept and recorded; a template's `${…}` substitutions stay code,
 * nested templates included. Offsets are unchanged, so a match in `code` is a
 * match at the same offset in the source. A `/` is a regex after `(`, `,`, `=`,
 * `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, the start, or `return`/`typeof`/
 * `default`; otherwise division.
 */
function codeView(source: string): ICodeView {
  const code = source.split('');
  const text = source.split('');
  const strings: { start: number; end: number }[] = [];
  // Template text is blanked in `code` only; a comment or a regex body in both.
  const blank = (from: number, to: number, both = false): void => {
    for (let at = from; at < to; at++) {
      if (code[at] === '\n' || code[at] === '\r') continue;
      code[at] = ' ';
      if (both) text[at] = ' ';
    }
  };
  // Each open template substitution's brace depth; a template body resumes when it closes.
  const substitutions: number[] = [];
  let depth = 0;
  let previous = '';
  let at = 0;
  const templateBody = (): void => {
    // `at` is just past a backtick, or just past a substitution's closing `}`.
    const start = at;
    for (; at < source.length; at++) {
      if (source[at] === '\\') at++;
      else if (source[at] === '`') {
        blank(start - 1, at + 1);
        at++;
        previous = 'value';
        return;
      } else if (source[at] === '$' && source[at + 1] === '{') {
        blank(start - 1, at + 2);
        at += 2;
        substitutions.push(depth);
        depth++;
        previous = '(';
        return;
      }
    }
    blank(start - 1, source.length);
  };
  while (at < source.length) {
    const char = source[at]!;
    const next = source[at + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at);
      blank(at, end === -1 ? source.length : end, true);
      at = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2);
      blank(at, end === -1 ? source.length : end + 2, true);
      at = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      const start = at;
      for (at++; at < source.length && source[at] !== char && source[at] !== '\n'; at++)
        if (source[at] === '\\') at++;
      at++;
      strings.push({ start, end: Math.min(at, source.length) });
      previous = 'value';
    } else if (char === '`') {
      at++;
      templateBody();
    } else if (char === '}' && substitutions.length > 0 && depth - 1 === substitutions.at(-1)) {
      substitutions.pop();
      depth--;
      at++;
      templateBody();
    } else if (
      char === '/' &&
      (previous === '' ||
        '(,=:[!&|?{};'.includes(previous) ||
        ['return', 'typeof', 'default'].includes(previous))
    ) {
      const start = at;
      let inClass = false;
      for (at++; at < source.length && source[at] !== '\n'; at++) {
        if (source[at] === '\\') at++;
        else if (source[at] === '[') inClass = true;
        else if (source[at] === ']') inClass = false;
        else if (source[at] === '/' && !inClass) break;
      }
      at++;
      while (/[a-z]/.test(source[at] ?? '')) at++;
      blank(start, Math.min(at, source.length), true);
      previous = 'value';
    } else if (/[A-Za-z_$]/.test(char)) {
      const start = at;
      while (/[\w$]/.test(source[at] ?? '')) at++;
      previous = source.slice(start, at);
    } else {
      if (char === '{') depth++;
      else if (char === '}') depth--;
      if (!/\s/.test(char)) previous = /[0-9)\]]/.test(char) ? 'value' : char;
      at++;
    }
  }
  return { code: code.join(''), text: text.join(''), strings };
}

/**
 * For every `opener` in `code`, the index of the `closer` that balances it,
 * skipping quoted strings, in one linear pass (per-head scanning was quadratic
 * on unclosed input). An opener that never closes maps to the length.
 */
function closingIndexes(code: string, opener: string, closer: string): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < code.length; at++) {
    const char = code[at]!;
    if (char === "'" || char === '"') {
      for (at++; at < code.length && code[at] !== char && code[at] !== '\n'; at++)
        if (code[at] === '\\') at++;
    } else if (char === opener) open.push(at);
    else if (char === closer && open.length > 0) closes.set(open.pop()!, at);
  }
  for (const at of open) closes.set(at, code.length);
  return closes;
}

/** Finds supported literal worker URLs; refuses other task references by location. */
export function taskReferences(source: string, file: string): readonly ITaskReference[] {
  const view = codeView(source);
  const strings = view.strings;
  const visible = view.code
    // Bounded to a type-only head, so a file without semicolons stays linear (audit F3).
    .replace(
      /\b(?:import|export)\s+type\s*(?:\{[^}]*\}|[\w$*,\s]+?)\s*\bfrom\s*(['"])[^'"]+\1\s*;?/g,
      (text) => text.replace(/[^\r\n]/g, ' '),
    );
  const references: ITaskReference[] = [];
  const literal =
    // Prettier wraps a long call one argument per line, with a trailing comma.
    /\bnew\s+URL\(\s*(['"])(\.[^'"\\\r\n]*\.task\.ts)\1\s*,\s*import\.meta\.url\s*,?\s*\)/g;
  for (const match of visible.matchAll(literal)) {
    if (strings.some((range) => match.index >= range.start && match.index < range.end)) continue;
    references.push({
      start: match.index,
      end: match.index + match[0].length,
      target: resolveDir(dirName(file), match[2]!),
    });
  }
  const parens = closingIndexes(visible, '(', ')');
  for (const match of visible.matchAll(
    // A call head (new URL, a dynamic import, import.meta.resolve) spans to its
    // balanced `)`, so a nested call or a string cannot end it early. `import`
    // is the keyword only (not `importer`, not any other `import.meta`); a
    // static import runs to its line end, and `from '….task.ts'` covers an
    // `export … from` and a wrapped import.
    /\bnew\s+URL\s*\(|\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(|\bimport\b(?!\s*\.)(?:\s*\(|[^;\r\n]*)|\bfrom\s*(['"])[^'"\r\n]*\.task\.ts\1/g,
  )) {
    if (strings.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const head = match.index + match[0].length;
    const end = match[0].endsWith('(') ? (parens.get(head - 1) ?? visible.length) + 1 : head;
    if (
      // Template text counts (a computed specifier), a comment does not.
      view.text.slice(match.index, end).includes('.task.ts') &&
      !references.some((ref) => match.index === ref.start)
    ) {
      throw new Error(
        `${file}:${visible.slice(0, match.index).split('\n').length}: worker task references must use new URL('<relative>.task.ts', import.meta.url).`,
      );
    }
  }
  return references;
}

function relativePath(from: string, to: string): string {
  const left = from.split('/');
  const right = to.split('/');
  while (left.length > 0 && left[0] === right[0]) {
    left.shift();
    right.shift();
  }
  const path = [...left.map(() => '..'), ...right].join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * The files esbuild 0.28 tries for a relative import, in its order (measured):
 * the path as written; for `.js`/`.jsx` the `.ts` then `.tsx` sibling (`.mjs`
 * gives `.mts`, `.cjs` gives `.cts`), which `moduleResolution: "bundler"` and the
 * dev runner allow; and for an extensionless path its default resolveExtensions
 * order, then the directory index.
 */
function moduleCandidates(absolute: string): readonly string[] {
  const script = /\.([cm]?)js(x?)$/.exec(absolute);
  if (script !== null) {
    const stem = absolute.slice(0, script.index);
    const siblings = script[1] === 'm' ? ['.mts'] : script[1] === 'c' ? ['.cts'] : ['.ts', '.tsx'];
    return [absolute, ...siblings.map((extension) => stem + extension)];
  }
  if (/\.[cm]?tsx?$/.test(absolute)) return [absolute];
  // esbuild's default resolveExtensions order, then the directory index.
  return ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'].map(
    (suffix) => absolute + suffix,
  );
}

/** The first candidate that exists, so a `.js` import of a `.ts` file is followed. */
async function localModule(fs: IFileSystem, absolute: string): Promise<string | undefined> {
  for (const candidate of moduleCandidates(absolute)) {
    if ((await sourceText(fs, candidate)) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The specifiers a module imports, requires or re-exports, read only from its
 * code view: a commented-out `require('./legacy.js')`, a quoted example or a
 * regex is not followed, while a `require` in a template substitution is
 * (CodeRabbit #582). The specifier strings themselves are kept.
 */
function moduleSpecifiers(source: string): readonly string[] {
  const { code, strings } = codeView(source);
  const found: string[] = [];
  for (const match of code.matchAll(
    // `require('./x')` too: esbuild bundles a literal require target.
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
  )) {
    if (strings.some((range) => match.index >= range.start && match.index < range.end)) continue;
    found.push(match[1]!);
  }
  return found;
}

/** Scans local modules reachable from the application entries, including nested tasks. */
export async function discoverTasks(
  fs: IFileSystem,
  root: string,
  entries: readonly string[],
): Promise<readonly string[]> {
  const pending = entries.map((entry) => resolveDir(root, entry));
  const visited = new Set<string>();
  const tasks = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await sourceText(fs, file);
    if (source === undefined) continue; // esbuild reports missing imports.
    for (const ref of taskReferences(source, file)) {
      await assertInsideProject(fs, root, ref.target);
      tasks.add(ref.target.slice(root.length + 1));
      pending.push(ref.target);
    }
    for (const imported of moduleSpecifiers(source)) {
      const path = imported;
      if (path.startsWith('.')) {
        const found = await localModule(fs, resolveDir(dirName(file), path));
        if (found !== undefined) pending.push(found);
      }
    }
  }
  return [...tasks].sort();
}

/** Rewrites each task URL relative to its containing emitted bundle. */
export function taskRewritePlugin(
  fs: IFileSystem,
  root: string,
  entry: string,
  tasks: readonly string[] = [],
): Plugin {
  const built = new Set(tasks.map((task) => resolveDir(root, task)));
  return {
    name: 'setu-worker-tasks',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        // Dependencies are bundled as published: only the application's own
        // sources can name a task, and esbuild loads everything else itself.
        if (/[\\/]node_modules[\\/]/.test(path)) return undefined;
        const source = await sourceText(fs, path);
        if (source === undefined) return undefined;
        const refs = taskReferences(source, path);
        if (refs.length === 0) return undefined;
        const base = resolveDir(root, entry);
        let contents = source;
        for (const ref of [...refs].reverse()) {
          const location = `${path}:${source.slice(0, ref.start).split('\n').length}`;
          try {
            await assertInsideProject(fs, root, ref.target);
          } catch {
            throw new Error(
              `${location}: worker task target is outside the project: ${ref.target}. setu build bundles only this project's own task files; move the task into the project that runs it (a workspace library cannot ship one).`,
            );
          }
          if (!built.has(ref.target))
            throw new Error(`${location}: worker task target was not built: ${ref.target}.`);
          const specifier = relativePath(dirName(base), ref.target).replace(/\.ts$/, '.js');
          contents = `${contents.slice(0, ref.start)}new URL('${specifier}', import.meta.url)${contents.slice(ref.end)}`;
        }
        return {
          contents,
          loader: path.endsWith('tsx')
            ? 'tsx'
            : path.endsWith('ts')
              ? 'ts'
              : path.endsWith('jsx')
                ? 'jsx'
                : 'js',
        };
      });
    },
  };
}

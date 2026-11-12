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

/**
 * For every `opener` in `text`, the index of the `closer` that balances it,
 * skipping string and template literals, so a `)` or `}` inside a string or a
 * nested call does not end a span early (CodeRabbit #582). One linear pass:
 * looking each span up again per head was quadratic on unclosed input. An
 * opener that never closes maps to the text's length.
 */
function closingIndexes(text: string, opener: string, closer: string): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "'" || char === '"' || char === '`') {
      for (at++; at < text.length && text[at] !== char; at++) if (text[at] === '\\') at++;
    } else if (char === opener) open.push(at);
    else if (char === closer && open.length > 0) closes.set(open.pop()!, at);
  }
  for (const at of open) closes.set(at, text.length);
  return closes;
}

/**
 * Whether any `${…}` substitution in a template literal names a `.task.ts`
 * path. Braces are counted, so an object literal inside the substitution does
 * not end it early (CodeRabbit #582).
 */
function substitutionNamesTask(template: string): boolean {
  // The body between the backticks: the literal's own delimiters are not strings in it.
  const body = template.slice(1, -1);
  const closes = closingIndexes(body, '{', '}');
  for (let at = body.indexOf('${'); at !== -1; at = body.indexOf('${', at + 1)) {
    const end = closes.get(at + 1) ?? body.length;
    // Only a task REFERENCE: a `new URL(…)` or an `import` naming the path. A
    // substitution that merely formats a string mentioning one is ordinary code.
    const substitution = body.slice(at, end);
    if (substitution.includes('.task.ts') && /\bnew\s+URL\s*\(|\bimport\b/.test(substitution))
      return true;
  }
  return false;
}

/** Finds supported literal worker URLs; refuses other task references by location. */
export function taskReferences(source: string, file: string): readonly ITaskReference[] {
  // Consume strings before comments so a URL in a string cannot begin a comment.
  const strings: { readonly start: number; readonly end: number }[] = [];
  const visible = source
    .replace(
      /(['"])(?:\\.|(?!\1)[^\\])*?\1|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?<=(?:^|[=(,:;[!&|?{}]|\breturn|\bdefault)\s*)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n[])+\/[dgimsuvy]*/g,
      (text: string, quote: string | undefined, offset: number) => {
        if (quote !== undefined) strings.push({ start: offset, end: offset + text.length });
        // A `${…}` substitution is code, so a task named inside one would be
        // blanked with the template text and silently left unbuilt: refuse it.
        if (text.startsWith('`') && substitutionNamesTask(text))
          throw new Error(
            `${file}:${source.slice(0, offset).split('\n').length}: worker task references must use new URL('<relative>.task.ts', import.meta.url) outside a template literal.`,
          );
        return quote === undefined ? text.replace(/[^\r\n]/g, ' ') : text;
      },
    )
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
    // A call head (`new URL(`, `import(`, `import.meta.resolve(`) spans to its
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
      source.slice(match.index, end).includes('.task.ts') &&
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
 * The specifiers a module imports, requires or re-exports, read only from code:
 * comments are blanked and a match that starts inside a string is skipped, so
 * a commented-out `require('./legacy.js')` or a quoted example is not followed
 * (CodeRabbit #582). The specifier strings themselves are kept.
 */
function moduleSpecifiers(source: string): readonly string[] {
  const strings: { readonly start: number; readonly end: number }[] = [];
  const code = source.replace(
    /(['"])(?:\\.|(?!\1)[^\\])*?\1|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (text: string, quote: string | undefined, offset: number) => {
      if (quote !== undefined) {
        strings.push({ start: offset, end: offset + text.length });
        return text;
      }
      return text.replace(/[^\r\n]/g, ' ');
    },
  );
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

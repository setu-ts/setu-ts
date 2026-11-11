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

/** Finds supported literal worker URLs; refuses other task references by location. */
export function taskReferences(source: string, file: string): readonly ITaskReference[] {
  // Consume strings before comments so a URL in a string cannot begin a comment.
  const strings: { readonly start: number; readonly end: number }[] = [];
  const visible = source
    .replace(
      /(['"])(?:\\.|(?!\1)[^\\])*?\1|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?<=(?:^|[=(,:;[!&|?{}]|\breturn|\bdefault)\s*)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n[])+\/[dgimsuvy]*/g,
      (text: string, quote: string | undefined, offset: number) => {
        if (quote !== undefined) strings.push({ start: offset, end: offset + text.length });
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
  for (const match of visible.matchAll(
    // `import` the keyword only (not `importer`, not any `import.meta`); a separate
    // arm refuses `import.meta.resolve(…)`, Prettier-wrapped or not, and another a
    // static `from '….task.ts'`: an `export … from` or a wrapped import.
    /\bnew\s+URL\s*\([^)]*\)|\bimport\b(?!\s*\.)(?:\s*\([^)]*\)|[^;\r\n]*)|\bimport\s*\.\s*meta\s*\.\s*resolve\s*\([^)]*\)|\bfrom\s*(['"])[^'"\r\n]*\.task\.ts\1/g,
  )) {
    if (strings.some((range) => match.index >= range.start && match.index < range.end)) continue;
    if (
      source.slice(match.index, match.index + match[0].length).includes('.task.ts') &&
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
    for (const imported of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g,
    )) {
      const path = imported[1]!;
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

/** Worker task discovery and per-output URL relocation for Node bundles. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { Plugin } from 'esbuild';
import {
  assertInsideProject,
  dirName,
  readExistingText,
  resolveDir,
} from '../utils/file-writer.ts';

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
      /(['"])(?:\\.|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      (text: string, quote: string | undefined, offset: number) => {
        if (quote !== undefined) strings.push({ start: offset, end: offset + text.length });
        return text.startsWith('/') ? text.replace(/[^\r\n]/g, ' ') : text;
      },
    )
    .replace(/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*(['"])[^'"]+\1\s*;?/g, (text) =>
      text.replace(/[^\r\n]/g, ' '),
    );
  const references: ITaskReference[] = [];
  const literal =
    /\bnew\s+URL\(\s*(['"])(\.[^'"\\\r\n]*\.task\.ts)\1\s*,\s*import\.meta\.url\s*\)/g;
  for (const match of visible.matchAll(literal)) {
    if (strings.some((range) => match.index >= range.start && match.index < range.end)) continue;
    references.push({
      start: match.index,
      end: match.index + match[0].length,
      target: resolveDir(dirName(file), match[2]!),
    });
  }
  for (const match of visible.matchAll(/\.task\.ts/g)) {
    if (!references.some((ref) => match.index >= ref.start && match.index < ref.end)) {
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
    await assertInsideProject(fs, root, file);
    const source = await readExistingText(fs, file);
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
        const absolute = resolveDir(dirName(file), path);
        if (/\.[cm]?[jt]sx?$/.test(path)) pending.push(absolute);
        else {
          for (const suffix of ['.ts', '.tsx', '/index.ts']) {
            if ((await readExistingText(fs, absolute + suffix)) !== undefined) {
              pending.push(absolute + suffix);
              break;
            }
          }
        }
      }
    }
  }
  return [...tasks].sort();
}

/** Rewrites each task URL relative to its containing emitted bundle. */
export function taskRewritePlugin(fs: IFileSystem, root: string, entry: string): Plugin {
  return {
    name: 'setu-worker-tasks',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        const source = await readExistingText(fs, path);
        if (source === undefined) return undefined;
        const refs = taskReferences(source, path);
        const base = resolveDir(root, entry);
        let contents = source;
        for (const ref of [...refs].reverse()) {
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

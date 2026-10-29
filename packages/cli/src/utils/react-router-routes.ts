/** React Router's resolved page tree, read only by generation (never by setu check). @module */
import type { CommandRunner } from './run-command.ts';
import { joinPath } from './file-writer.ts';

function normalized(path: string): string {
  return `/${path.split('/').filter(Boolean).join('/')}`;
}

/** One parser owns both path calculation and the page filenames used in refusals. */
function pages(tree: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (nodes: unknown, parent: string): void => {
    if (!Array.isArray(nodes)) throw new Error('expected an array of React Router routes');
    for (const node of nodes) {
      if (
        typeof node !== 'object' ||
        node === null ||
        typeof node.id !== 'string' ||
        (node.path !== undefined && typeof node.path !== 'string') ||
        (node.file !== undefined && typeof node.file !== 'string') ||
        (node.index !== undefined && typeof node.index !== 'boolean')
      ) {
        throw new Error('expected React Router route objects with string ids');
      }
      const path = normalized(`${parent}/${node.path ?? ''}`);
      if (node.path !== undefined || node.index === true || node.children === undefined) {
        found.set(
          path,
          typeof node.file === 'string' ? `app/${node.file.replace(/^\.\//, '')}` : node.id,
        );
      }
      if (node.children !== undefined) walk(node.children, path);
    }
  };
  walk(tree, '');
  return found;
}

/** Joins route segments, including index routes' own paths, across pathless layouts. */
export function pagePaths(tree: unknown): string[] {
  return [...pages(tree).keys()];
}

/** Whether either generated GET route takes this page away; splats retain other matches. */
export function kernelShadows(kernelBase: string, page: string): boolean {
  if (page.includes('*')) return false;
  const base = normalized(kernelBase);
  const path = normalized(page);
  return (
    path === base || (path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes('/'))
  );
}

/** A failed read is advisory: projects may generate before installing frontend dependencies. */
export type PagePathsResult =
  | {
      readonly ok: true;
      readonly paths: readonly string[];
      readonly files: ReadonlyMap<string, string>;
    }
  | { readonly ok: false; readonly reason: string };

/** Runs the installed CLI directly, without a package manager or any network fetch. Never throws. */
export async function readPagePaths(
  dir: string,
  runCommand: CommandRunner,
): Promise<PagePathsResult> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runCommand(joinPath(dir, 'node_modules/.bin/react-router'), ['routes', '--json'], {
        cwd: dir,
        signal: abort.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('React Router route read timed out after 15 s'));
          abort.abort();
        }, 15_000);
      }),
    ]);
    if (result.code !== 0)
      return { ok: false, reason: `React Router exited ${result.code}: ${result.stderr.trim()}` };
    const tree: unknown = JSON.parse(result.stdout);
    const files = pages(tree);
    return { ok: true, paths: pagePaths(tree), files };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    clearTimeout(timer);
  }
}

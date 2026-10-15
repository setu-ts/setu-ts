/**
 * Read grants for the two documentation gates that evaluate document-supplied
 * code under Node's permission model (`check-prose-assertions`,
 * `check-example-behaviour`). The child may read only what importing a
 * workspace package needs: the package sources, `node_modules`, the two root
 * manifests the workspace resolver reads, and the source hooks and sandbox
 * preload themselves. Never the whole repository, which would expose
 * `.git/config` (where a CI checkout keeps its token) and any local `.env` file.
 *
 * The permission model checks a path, not the file a symlink names, so a symlink
 * committed under a granted directory could read anything. The gates therefore
 * refuse to start while a tracked symlink inside the grants points outside them.
 *
 * Some builtins read or write files without asking the permission model:
 * `node:sqlite` opens any path, and `node:module` could unregister the guards.
 * The preload (`sandbox-preload.ts`) refuses those builtins on every route a
 * module can reach them by: `import`, `require` and `process.getBuiltinModule`.
 *
 * @module
 */

import { readlink } from 'node:fs/promises';
import type { registerHooks } from 'node:module';
import { posix, resolve } from 'node:path';
import { run } from './run.ts';

/** Repository-relative paths every documentation sandbox may read. */
export const SANDBOX_READ_PATHS: readonly string[] = [
  'packages',
  'node_modules',
  'deno.json',
  'package.json',
  'test/node-source-register.ts',
  'test/node-source-hooks.ts',
  'scripts/codemods/workspace-sources.ts',
  'scripts/lib/sandbox-preload.ts',
  'scripts/lib/sandbox.ts',
  'scripts/lib/run.ts',
];

/** A git-tracked symlink: its repository-relative path and its target as stored. */
export interface TrackedSymlink {
  readonly path: string;
  readonly target: string;
}

function granted(path: string, grants: readonly string[]): boolean {
  return grants.some((grant) => path === grant || path.startsWith(`${grant}/`));
}

/**
 * Finds tracked symlinks inside the grants whose target lies outside them.
 *
 * @param links - Tracked symlinks, repository-relative
 * @param extra - Further granted paths
 * @returns The offending symlink paths
 */
export function escapingSymlinks(
  links: readonly TrackedSymlink[],
  extra: readonly string[] = [],
): string[] {
  const grants = [...SANDBOX_READ_PATHS, ...extra];
  return links
    .filter((link) => granted(link.path, grants))
    .filter((link) => {
      if (posix.isAbsolute(link.target)) return true;
      const target = posix.normalize(posix.join(posix.dirname(link.path), link.target));
      return target.startsWith('../') || !granted(target, grants);
    })
    .map((link) => link.path);
}

/**
 * Lists every symlink git tracks in the repository.
 *
 * @param root - Repository root
 * @returns Each symlink's path and stored target
 */
export async function trackedSymlinks(root: string): Promise<TrackedSymlink[]> {
  const listed = await run('git', ['ls-files', '-s', '-z'], { cwd: root });
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  const links: TrackedSymlink[] = [];
  for (const entry of listed.stdout.split('\0')) {
    // `-z` records end in NUL, so a path may hold any other character, line
    // terminators included: split on the first tab rather than matching `.`.
    const tab = entry.indexOf('\t');
    if (!entry.startsWith('120000 ') || tab === -1) continue;
    const path = entry.slice(tab + 1);
    links.push({ path, target: await readlink(resolve(root, path)) });
  }
  return links;
}

/**
 * Builds the `--allow-fs-read` flags for a documentation sandbox, after checking
 * that no tracked symlink lets the grants reach further than they name.
 *
 * @param root - Repository root the paths are relative to
 * @param extra - Further repository-relative paths this gate needs (its scratch directory)
 * @param listLinks - Symlink lister (injected by tests)
 * @returns One `--allow-fs-read=<absolute path>` flag per path
 * @throws {Error} When a tracked symlink inside the grants points outside them
 */
export async function sandboxReadFlags(
  root: string,
  extra: readonly string[] = [],
  listLinks: (root: string) => Promise<readonly TrackedSymlink[]> = trackedSymlinks,
): Promise<string[]> {
  const escaping = escapingSymlinks(await listLinks(root), extra);
  if (escaping.length > 0) {
    throw new Error(
      `Refusing to run the documentation sandbox: tracked symlink(s) inside its read grants ` +
        `point outside them: ${escaping.join(', ')}`,
    );
  }
  return [...SANDBOX_READ_PATHS, ...extra].map((path) => `--allow-fs-read=${resolve(root, path)}`);
}

/** The `--import` arguments every documentation sandbox loads, in order. */
export const SANDBOX_IMPORTS: readonly string[] = [
  '--import',
  './test/node-source-register.ts',
  '--import',
  './scripts/lib/sandbox-preload.ts',
];

/** Builtins the sandbox refuses: each bypasses the permission model or the guards. */
export const DENIED_BUILTINS: readonly string[] = [
  'sqlite',
  'wasi',
  'inspector',
  'inspector/promises',
  'module',
];

/**
 * Whether a specifier names a refused builtin, with or without the `node:` scheme.
 *
 * @param specifier - A module specifier or builtin id
 * @returns True when the sandbox refuses it
 */
export function isDeniedBuiltin(specifier: string): boolean {
  return DENIED_BUILTINS.includes(specifier.replace(/^node:/, ''));
}

function refuse(specifier: string): never {
  throw Object.assign(new Error(`${specifier} is not available in the documentation sandbox`), {
    code: 'ERR_ACCESS_DENIED',
  });
}

/**
 * Refuses the denied builtins through module resolution (`import` and `require`)
 * and through `process.getBuiltinModule`, which skips resolution hooks. The
 * replacement is non-configurable, so document code cannot restore the original.
 *
 * @param register - `module.registerHooks`
 * @param target - The process whose `getBuiltinModule` is replaced
 */
export function installSandboxGuards(
  register: typeof registerHooks,
  target: Pick<NodeJS.Process, 'getBuiltinModule'>,
): void {
  register({
    resolve(specifier, context, nextResolve) {
      if (isDeniedBuiltin(specifier)) refuse(specifier);
      return nextResolve(specifier, context);
    },
  });
  const original = target.getBuiltinModule.bind(target);
  Object.defineProperty(target, 'getBuiltinModule', {
    value: (id: string) => (isDeniedBuiltin(id) ? refuse(id) : original(id)),
    writable: false,
    configurable: false,
  });
}

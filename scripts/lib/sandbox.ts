/**
 * Read grants for the two documentation gates that evaluate document-supplied
 * code under Node's permission model (`check-prose-assertions`,
 * `check-example-behaviour`). The child may read only what importing a
 * workspace package needs: the package sources, `node_modules`, the two root
 * manifests the workspace resolver reads, and the source hooks themselves. Never
 * the whole repository, which would expose `.git/config` (where a CI checkout
 * keeps its token) and any local `.env` file.
 *
 * @module
 */

import { resolve } from 'node:path';

/** Repository-relative paths every documentation sandbox may read. */
export const SANDBOX_READ_PATHS: readonly string[] = [
  'packages',
  'node_modules',
  'deno.json',
  'package.json',
  'test/node-source-register.ts',
  'test/node-source-hooks.ts',
  'scripts/codemods/workspace-sources.ts',
];

/**
 * Builds the `--allow-fs-read` flags for a documentation sandbox.
 *
 * @param root - Repository root the paths are relative to
 * @param extra - Further repository-relative paths this gate needs (its scratch directory)
 * @returns One `--allow-fs-read=<absolute path>` flag per path
 */
export function sandboxReadFlags(root: string, extra: readonly string[] = []): string[] {
  return [...SANDBOX_READ_PATHS, ...extra].map((path) => `--allow-fs-read=${resolve(root, path)}`);
}

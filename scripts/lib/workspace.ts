/**
 * Reads the authored pnpm workspace inventory for repository tooling.
 * Framework members retain file order; runnable apps are discovered separately.
 *
 * @module
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

type ReadText = (path: string) => Promise<string>;

/** Read and validate the authored pnpm packages list. */
async function inventory(
  root = '.',
  readText: ReadText = (path) => readFile(path, 'utf8'),
): Promise<string[]> {
  const path = join(root, 'pnpm-workspace.yaml');
  let content: unknown;
  try {
    content = parse(await readText(path));
  } catch (cause) {
    throw new Error(`${path}: cannot read workspace YAML`, { cause });
  }
  if (
    typeof content !== 'object' ||
    content === null ||
    !('packages' in content) ||
    !Array.isArray(content.packages) ||
    !content.packages.every((entry: unknown) => typeof entry === 'string')
  ) {
    throw new Error(`${path}: expected a packages list of strings`);
  }
  return (content.packages as string[]).map((entry) => entry.replace(/^\.\//, ''));
}

/** Read framework members only, including nested starters, in authored order. */
export async function workspaceMembers(
  root = '.',
  readText: ReadText = (path) => readFile(path, 'utf8'),
): Promise<string[]> {
  return (await inventory(root, readText)).filter((entry) => entry.startsWith('packages/'));
}

/** Expand apps/* to app directories with a package.json, in deterministic order. */
export async function workspaceApps(root = '.'): Promise<string[]> {
  if (!(await inventory(root)).includes('apps/*')) {
    throw new Error('pnpm-workspace.yaml: expected apps/*');
  }
  const apps: string[] = [];
  for (const entry of await readdir(join(root, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await stat(join(root, 'apps', entry.name, 'package.json'))).isFile()) {
        apps.push(`apps/${entry.name}`);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return apps.sort();
}

/* eslint-disable no-console -- this CI script emits a human-readable drift report. */
/**
 * Compares package versions in the committed and freshly resolved pnpm lockfiles.
 */

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

/** The lockfile subset needed to attribute a range resolution. */
export interface IDriftLockfile {
  readonly packages?: Readonly<Record<string, unknown>>;
}

/** One changed direct resolution, identified by its original specifier. */
export interface IDependencyDrift {
  readonly specifier: string;
  readonly packageName: string;
  readonly previous: string | null;
  readonly current: string | null;
}

/**
 * Extracts a package name from a pnpm resolved-package key.
 *
 * @param specifier - Package name followed by its exact version.
 * @returns Package name, or the original specifier for non-registry imports.
 */
export function packageNameOf(specifier: string): string {
  const match = /^((?:@[^/]+\/)?[^@/]+)@/.exec(specifier);
  return match?.[1] ?? specifier;
}

/**
 * Finds changes between a committed and a fresh range resolution.
 *
 * @param committed - The lockfile reviewed with the repository commit.
 * @param fresh - A lockfile resolved with `--reload` and no frozen lock.
 * @returns Deterministically ordered changed and newly resolved ranges.
 */
export function findDependencyDrift(
  committed: IDriftLockfile,
  fresh: IDriftLockfile,
): readonly IDependencyDrift[] {
  const versions = (lock: IDriftLockfile): Map<string, string> => {
    const byName = new Map<string, string[]>();
    for (const key of Object.keys(lock.packages ?? {}).sort()) {
      const name = packageNameOf(key);
      const entries = byName.get(name) ?? [];
      entries.push(key.slice(name.length + 1));
      byName.set(name, entries);
    }
    return new Map([...byName].map(([name, entries]) => [name, entries.join(', ')]));
  };
  const before = versions(committed);
  const after = versions(fresh);
  const specifiers = new Set([...before.keys(), ...after.keys()]);

  return [...specifiers].sort().flatMap((specifier): IDependencyDrift[] => {
    const previous = before.get(specifier) ?? null;
    const current = after.get(specifier) ?? null;
    if (previous === current) return [];
    return [{ specifier, packageName: specifier, previous, current }];
  });
}

/**
 * Produces Markdown suitable for a GitHub Actions summary or drift issue.
 *
 * @param changes - Attributed resolution changes.
 * @returns Complete Markdown report.
 */
export function formatDependencyDrift(changes: readonly IDependencyDrift[]): string {
  if (changes.length === 0) {
    return '## Dependency drift\n\nNo dependency resolution changed.\n';
  }

  const rows = changes.map(
    (change) =>
      `| \`${change.packageName}\` | \`${change.specifier}\` | ` +
      `\`${change.previous ?? 'not locked'}\` | \`${change.current ?? 'removed'}\` |`,
  );
  return [
    '## Dependency drift',
    '',
    '| Package | Specifier | Committed | Fresh resolution |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * Reads the lockfile portion used by the drift comparison.
 *
 * @param path - Lockfile path supplied by the workflow.
 * @returns Parsed lockfile specifier resolutions.
 */
async function readLockfile(path: string): Promise<IDriftLockfile> {
  return parse(await readFile(path, 'utf8')) as IDriftLockfile;
}

/**
 * Runs the command-line drift report.
 *
 * @returns Process exit status for the command-line caller.
 */
async function main(): Promise<number> {
  const [committedPath, freshPath] = process.argv.slice(2);
  if (committedPath === undefined || freshPath === undefined) {
    console.error('usage: dependency-drift.ts <committed-lock> <fresh-lock>');
    return 2;
  }
  const changes = findDependencyDrift(
    await readLockfile(committedPath),
    await readLockfile(freshPath),
  );
  console.log(formatDependencyDrift(changes));
  return 0;
}

if (import.meta.main) {
  await (async () => {
    process.exitCode = await main();
    return;
  })();
}

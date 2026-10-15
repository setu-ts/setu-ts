/* eslint-disable no-console -- release artifact writer */
/** Captures the installed pnpm dependency set attached to a release. @module */

import { readFile, writeFile } from 'node:fs/promises';
import { parsePnpmLock } from './lib/pnpm-lock.ts';

/** The resolved-package portion of a pnpm lockfile. */
export interface IPnpmLockfile {
  readonly lockfileVersion: string;
  readonly packages?: Readonly<
    Record<string, { readonly resolution: { readonly integrity?: string } }>
  >;
}

/** Versioned resolved set; keys are exact package names and versions. */
export interface IReleaseResolvedSet {
  readonly version: string;
  readonly lockfileVersion: string;
  readonly packages: Readonly<Record<string, { readonly integrity?: string }>>;
}

/** Returns the sorted resolved set, retaining registry integrity when present. */
export function createReleaseResolvedSet(
  version: string,
  lockfile: IPnpmLockfile,
): IReleaseResolvedSet {
  if (version === '') throw new TypeError('release version must not be empty');
  if (lockfile.lockfileVersion === '')
    throw new TypeError('pnpm lockfile version must not be empty');
  return {
    version,
    lockfileVersion: lockfile.lockfileVersion,
    packages: Object.fromEntries(
      Object.entries(lockfile.packages ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [
          name,
          value.resolution.integrity === undefined ? {} : { integrity: value.resolution.integrity },
        ]),
    ),
  };
}

/** Stable, newline-terminated JSON for release upload. */
export function serializeReleaseResolvedSet(resolvedSet: IReleaseResolvedSet): string {
  return JSON.stringify(resolvedSet, null, 2) + '\n';
}

/** Writes a release asset from the repository lock without exiting its caller. */
export async function runResolvedSetMain(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const [version, output] = args;
  if (!version || !output) {
    console.error('usage: release-resolved-set.ts <version> <output-path>');
    return 2;
  } else {
    const lockfile = parsePnpmLock(await readFile('pnpm-lock.yaml', 'utf8'));
    await writeFile(
      output,
      serializeReleaseResolvedSet(createReleaseResolvedSet(version, lockfile)),
    );
    console.log(`Wrote resolved dependency set for ${version} to ${output}.`);
    return 0;
  }
}

if (import.meta.main) process.exitCode = await runResolvedSetMain();

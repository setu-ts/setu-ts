/**
 * @module
 *
 * Resolves every published package's real exports through one batched
 * `deno doc --json` call.
 *
 * Split from {@linkcode ../package-exports.ts} because that module is pure —
 * it renders, parses and diffs — while this one runs a subprocess. Keeping the
 * pure half free of I/O is what lets the documentation gate unit-test the
 * table shape without spawning `deno doc`.
 */

import type { PackageExports } from './package-exports.ts';
import { buildKindIndex, symbolsForFile } from './package-exports.ts';

export * from './package-exports.ts';

/**
 * Expands a package manifest's `exports` map into local barrel targets.
 *
 * @param pkgPath - Workspace-relative package directory
 * @returns Import specifier and workspace-relative target for each entrypoint
 */
export async function entrypointsFor(
  pkgPath: string,
): Promise<{ specifier: string; target: string }[]> {
  const manifest = JSON.parse(await Deno.readTextFile(`${pkgPath}/deno.json`)) as {
    name?: string;
    exports?: string | Record<string, string>;
  };
  const name = manifest.name ?? `@setu-ts/${pkgPath.split('/').pop()}`;
  const exports = manifest.exports;
  if (exports === undefined) return [];

  const strip = (target: string): string => `${pkgPath}/${target.replace(/^\.\//, '')}`;

  if (typeof exports === 'string') {
    return [{ specifier: name, target: strip(exports) }];
  }
  return Object.entries(exports).map(([key, target]) => ({
    specifier: key === '.' ? name : `${name}${key.replace(/^\./, '')}`,
    target: strip(target),
  }));
}

/**
 * Collects the exported symbols of every given package.
 *
 * One `deno doc --json` invocation covers all barrels, because a per-package
 * subprocess would put ~47 process spawns inside the documentation gate.
 *
 * @param packages - Workspace-relative package directories
 * @returns Exports grouped by package path, in manifest order
 * @throws {Error} If `deno doc` fails
 */
export async function collectPackageExports(
  packages: readonly string[],
): Promise<Map<string, PackageExports[]>> {
  const perPackage = new Map<string, { specifier: string; target: string }[]>();
  const allTargets: string[] = [];
  for (const pkgPath of packages) {
    const entrypoints = await entrypointsFor(pkgPath);
    perPackage.set(pkgPath, entrypoints);
    for (const entry of entrypoints) allTargets.push(entry.target);
  }

  const command = new Deno.Command('deno', {
    args: ['doc', '--json', ...allTargets],
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(`deno doc --json failed: ${new TextDecoder().decode(output.stderr)}`);
  }

  const payload = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    nodes?: Record<string, { symbols?: unknown[] }>;
  };

  // Built once over the whole payload so a re-exported symbol reports the kind
  // its declaring barrel gave it, rather than `deno doc`'s `reference`.
  const kindIndex = buildKindIndex(payload);

  const result = new Map<string, PackageExports[]>();
  for (const [pkgPath, entrypoints] of perPackage) {
    const groups: PackageExports[] = [];
    for (const entry of entrypoints) {
      const url = new URL(entry.target, `file://${Deno.cwd()}/`).href;
      groups.push({ specifier: entry.specifier, symbols: symbolsForFile(payload, url, kindIndex) });
    }
    result.set(pkgPath, groups);
  }
  return result;
}

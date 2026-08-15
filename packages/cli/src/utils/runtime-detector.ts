/**
 * Detection of a target project's runtime from the files it already carries.
 *
 * `setu generate` defaulted `SchematicOptions.runtime` to `'deno'` whenever
 * `--runtime` was not passed, which made the flag load-bearing for a value the
 * project already knows. Nobody passes it: `setu new svc --runtime bun` records
 * the choice once, and every later `setu generate` in that project silently
 * assumed Deno.
 *
 * That was harmless while `runtime` only reached custom schematics. It stopped
 * being harmless when the module schematic began choosing a test harness by
 * runtime — a Bun project got `@std/testing/bdd`, which reaches `Deno.test`
 * internally and cannot run there at all.
 *
 * Detected the same way plugins are: by reading the manifests the scaffold
 * wrote, never by booting anything.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { TargetRuntime } from '../constants.ts';
import { joinPath } from './file-writer.ts';

/**
 * Reads a file, or reports absence.
 *
 * @param fs - The filesystem to read through
 * @param path - The absolute path
 * @returns The contents, or `undefined` when the file cannot be read
 */
async function readText(fs: IFileSystem, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch {
    return undefined;
  }
}

/**
 * Detects the runtime a project was scaffolded for.
 *
 * The order is what makes it unambiguous. A Cloudflare Workers project carries
 * BOTH a `deno.json` (which `setu generate` reads for plugin gating) and a
 * `package.json` (which `wrangler` needs), so it has to be recognised by
 * `wrangler.toml` first or it would be misread as Node. Deno is last because it
 * is the only target with no second marker — it deliberately has no
 * `package.json`, since one would switch Deno to `node_modules` resolution.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory
 * @returns The detected runtime, defaulting to `'deno'` when nothing marks it
 */
export async function detectTargetRuntime(
  fs: IFileSystem,
  dir: string,
): Promise<TargetRuntime> {
  if (await readText(fs, joinPath(dir, 'wrangler.toml')) !== undefined) {
    return 'cloudflare-workers';
  }

  const packageJson = await readText(fs, joinPath(dir, 'package.json'));
  if (packageJson === undefined) return 'deno';

  // The `start` script is the marker, because it is what the two targets
  // genuinely differ on: Bun runs TypeScript directly, Node needs a loader.
  let start = '';
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    start = parsed.scripts?.['start'] ?? '';
  } catch {
    // An unparseable manifest is the plugin detector's problem to report, not
    // this one's; fall through to the safest reading.
    return 'deno';
  }

  if (start.startsWith('bun')) return 'bun';
  if (start !== '') return 'node';

  // A `package.json` with no `start` is not one this CLI wrote. Deno is the
  // safe answer: its harness is the only one that also type-checks elsewhere.
  return 'deno';
}

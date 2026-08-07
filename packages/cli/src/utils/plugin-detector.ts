/**
 * Detects installed `@setu-ts` packages by reading a project manifest.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { joinPath } from './file-writer.ts';

const SCOPE = '@setu-ts/';

/**
 * Reads and parses a JSON manifest.
 *
 * @param fs - The filesystem to read through
 * @param path - The manifest path
 * @returns The parsed object, or undefined when missing or malformed
 */
async function readManifest(
  fs: IFileSystem,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: Uint8Array;
  try {
    raw = await fs.readFile(path);
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    // Malformed manifest: treated as "no plugins detected", never a throw.
    return undefined;
  }
}

/**
 * Collects the bare package names of every `@setu-ts/*` key in a record.
 *
 * @param source - A record whose keys are package specifiers
 * @param into - The set to add to
 */
function collectScoped(source: unknown, into: Set<string>): void {
  if (typeof source !== 'object' || source === null) return;
  for (const key of Object.keys(source)) {
    if (key.startsWith(SCOPE)) {
      const name = key.slice(SCOPE.length);
      if (name !== '' && !name.includes('/')) into.add(name);
    }
  }
}

/**
 * Detects the `@setu-ts` packages a project depends on.
 *
 * Reads `deno.json` (its `imports` map) and, when that is absent or carries no
 * scoped entries, `package.json` (`dependencies` + `devDependencies`).
 * Detection never boots or imports the target project.
 *
 * A missing or malformed manifest yields an empty set rather than a throw, so
 * running the CLI outside a project is a plain "plugin not installed" gate
 * rather than a crash.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory to scan
 * @returns The bare package names found (e.g. `auth-plugin`, `cqrs-plugin`)
 */
export async function detectPlugins(
  fs: IFileSystem,
  dir: string,
): Promise<ReadonlySet<string>> {
  const plugins = new Set<string>();

  const denoJson = await readManifest(fs, joinPath(dir, 'deno.json'));
  if (denoJson !== undefined) {
    collectScoped(denoJson['imports'], plugins);
    if (plugins.size > 0) return plugins;
  }

  const packageJson = await readManifest(fs, joinPath(dir, 'package.json'));
  if (packageJson !== undefined) {
    collectScoped(packageJson['dependencies'], plugins);
    collectScoped(packageJson['devDependencies'], plugins);
  }

  return plugins;
}

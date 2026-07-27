/**
 * Detects installed @hono-enterprise plugins by reading manifest files.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';

/**
 * Detects installed @hono-enterprise plugins by reading the project's manifest.
 *
 * Reads deno.json (imports) or package.json (dependencies + devDependencies) to identify
 * installed @hono-enterprise package names. Does not bootstrap the application.
 *
 * @param fs - The filesystem interface (must contain readFile and stat)
 * @param dir - The directory to scan (defaults to current working directory)
 * @returns A ReadonlySet of plugin package names (e.g., "auth-plugin", "cache-plugin")
 */
export async function detectPlugins(
  fs: IFileSystem,
  dir = Deno.cwd(),
): Promise<ReadonlySet<string>> {
  // Try deno.json first (imports map)
  const denoPath = `${dir}/deno.json`;
  try {
    const content = await fs.readFile(denoPath);
    const deno = JSON.parse(new TextDecoder().decode(content));
    const imports = deno?.imports || {};
    const plugins = new Set<string>();

    for (const [key, value] of Object.entries(imports)) {
      if (
        typeof key === 'string' && key.startsWith('@hono-enterprise/') && typeof value === 'string'
      ) {
        // Extract package name from the import path
        const pkgName = key.split('/').pop()?.replace('@hono-enterprise/', '') ||
          key.replace('@hono-enterprise/', '');
        plugins.add(pkgName);
      }
    }

    return new FreezeSet(plugins);
  } catch {
    // deno.json not found or malformed, continue to package.json
  }

  // Fallback to package.json
  const pkgPath = `${dir}/package.json`;
  try {
    const content = await fs.readFile(pkgPath);
    const pkg = JSON.parse(new TextDecoder().decode(content));
    const plugins = new Set<string>();

    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};

    for (const [name] of Object.entries({ ...deps, ...devDeps })) {
      if (typeof name === 'string' && name.startsWith('@hono-enterprise/')) {
        const pkgName = name.replace('@hono-enterprise/', '');
        plugins.add(pkgName);
      }
    }

    return new FreezeSet(plugins);
  } catch {
    // package.json not found or malformed, return empty set
  }

  return new FreezeSet(new Set<string>());
}

// A FreezeSet returns a frozen set that behaves like ReadonlySet
class FreezeSet<T> extends Set<T> {
  constructor(source: Iterable<T> = []) {
    super(source);
    Object.freeze(this);
  }
}

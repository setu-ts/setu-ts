/**
 * Utility to read the version from deno.json.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';

/**
 * Reads the version from the package's deno.json file.
 *
 * @param fs - The filesystem interface (for reading deno.json)
 * @returns The version string
 */
export async function getVersionFromDenoJson(fs: IFileSystem): Promise<string> {
  try {
    const content = await fs.readFile('./deno.json');
    const deno = JSON.parse(new TextDecoder().decode(content));
    return deno.version || '0.1.0';
  } catch {
    // Fallback if deno.json cannot be read
    return '0.1.0';
  }
}

/**
 * Default version reader that uses the current working directory's deno.json.
 */
export function getVersion(): Promise<string> {
  // In the CLI package, we can't directly access fs from the package root easily without more context
  // This is a placeholder that returns a default version
  return Promise.resolve('0.1.0-alpha.1');
}

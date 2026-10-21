/** Advisory card presence checks, deliberately excluded from freshness checks. */
import type { IFileSystem } from '@setu-ts/common';
import { joinPath, MAX_EXISTING_FILE_BYTES, readExistingText } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';

/**
 * A special or overlarge file is treated as absent (the CLI will not open it),
 * while a real I/O error still surfaces rather than reading as absence.
 */
async function optionalText(fs: IFileSystem, path: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile || stat.size > MAX_EXISTING_FILE_BYTES) return undefined;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
    return undefined;
  }
  return await readExistingText(fs, path);
}

async function exists(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
    return false;
  }
}

/** Report one warning per missing card, or the setting needed for a node_modules tree. */
export async function cardWarnings(
  fs: IFileSystem,
  dir: string,
  installed: ReadonlySet<string>,
  workspaceRoot?: string,
): Promise<readonly string[]> {
  const locations = workspaceRoot === undefined ? [dir] : [dir, workspaceRoot];
  let modules = false;
  for (const location of locations) {
    try {
      modules = (await fs.stat(joinPath(location, 'node_modules'))).isDirectory;
      if (modules) break;
    } catch (cause) {
      if (!isMissingPath(cause)) throw cause;
    }
  }
  if (!modules) {
    const yarn = await optionalText(fs, joinPath(dir, '.yarnrc.yml'));
    const linker = /^\s*nodeLinker\s*:\s*['"]?([\w-]+)/m.exec(yarn ?? '')?.[1];
    if (
      linker === 'pnp' ||
      (linker === undefined && (await exists(fs, joinPath(dir, '.pnp.cjs'))))
    ) {
      return ['cards require node_modules — set nodeLinker: node-modules and run install'];
    }
    // nodeModulesDir is a root-only setting: Deno refuses it in a workspace member.
    for (const name of ['deno.json', 'deno.jsonc']) {
      const deno = await readJsonManifest(fs, joinPath(workspaceRoot ?? dir, name));
      if (
        deno.kind === 'ok' &&
        typeof deno.value === 'object' &&
        deno.value !== null &&
        !('nodeModulesDir' in deno.value)
      ) {
        return ['cards require node_modules — set "nodeModulesDir": "auto" and run install'];
      }
    }
  }
  const warnings: string[] = [];
  for (const pkg of [...installed].sort()) {
    const path = `node_modules/@setu-ts/${pkg}/AGENT_CARD.md`;
    let found = false;
    for (const location of locations) {
      try {
        await fs.stat(joinPath(location, path));
        found = true;
        break;
      } catch (cause) {
        if (!isMissingPath(cause)) throw cause;
      }
    }
    if (!found)
      warnings.push(
        `card not found: ${workspaceRoot === undefined ? '' : '../../'}${path} — run install`,
      );
  }
  return warnings;
}

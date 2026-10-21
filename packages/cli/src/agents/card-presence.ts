/** Advisory card presence checks, deliberately excluded from freshness checks. */
import type { IFileSystem } from '@setu-ts/common';
import { joinPath } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';

async function optionalText(fs: IFileSystem, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
    return undefined;
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
      (linker === undefined && (await optionalText(fs, joinPath(dir, '.pnp.cjs'))) !== undefined)
    ) {
      return ['cards require node_modules — set nodeLinker: node-modules and run install'];
    }
    for (const name of ['deno.json', 'deno.jsonc']) {
      const deno = await readJsonManifest(fs, joinPath(dir, name));
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

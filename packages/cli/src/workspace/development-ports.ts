/** Conservative inspector-script edits shared by adoption and port reallocation. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { TargetRuntime } from '../constants.ts';
import { sectionEntries } from './legacy-pins.ts';
import { parseJsonc } from '../utils/manifest-reader.ts';
import { joinPath, readExistingText, type GeneratedFile } from '../utils/file-writer.ts';
import { escapeName } from '../utils/names.ts';

/**
 * Replaces exactly one inspector token in start:debug, preserving all other manifest text.
 *
 * @param source - The member's JSON or JSONC manifest
 * @param section - The runtime's script section
 * @param port - The newly allocated inspector port
 * @param previous - The old port on reallocation; omitted when adopting a bare token
 * @returns Updated text, or undefined when the exact token cannot be identified once
 * @since 0.12.0
 */
export function rewriteInspectorScript(
  source: string,
  section: 'tasks' | 'scripts',
  port: number,
  previous?: number,
): string | undefined {
  try {
    parseJsonc(source);
  } catch {
    return undefined;
  }
  const entries = sectionEntries(source, [section]).filter((entry) => entry.name === 'start:debug');
  if (entries.length !== 1) return undefined;
  const entry = entries[0]!;
  const token = previous === undefined ? '--inspect' : `--inspect=127.0.0.1:${previous}`;
  const parts = entry.value.split(/(\s+)/);
  if (parts.filter((part) => part === token).length !== 1) return undefined;
  const updated = parts
    .map((part) => (part === token ? `--inspect=127.0.0.1:${port}` : part))
    .join('');
  return source.slice(0, entry.start) + JSON.stringify(updated) + source.slice(entry.end);
}

/**
 * Plans an inspector edit, or prints the exact token to set when the script is hand-edited.
 *
 * @param fs - The CLI filesystem
 * @param dir - The member directory
 * @param runtime - The member's runtime
 * @param port - The newly allocated inspector port
 * @param notice - Receives the manual edit when an automatic rewrite is unsafe
 * @param previous - The old port on reallocation; omitted on adoption
 * @returns The managed manifest edit, or an empty list when left unchanged
 * @since 0.12.0
 */
export async function planInspectorRewrite(
  fs: IFileSystem,
  dir: string,
  runtime: TargetRuntime,
  port: number,
  notice: (line: string) => void,
  previous?: number,
): Promise<readonly GeneratedFile[]> {
  const paths = runtime === 'deno' ? ['deno.json', 'deno.jsonc'] : ['package.json'];
  for (const file of paths) {
    const path = joinPath(dir, file);
    let source: string | undefined;
    try {
      source = await readExistingText(fs, path);
    } catch {
      notice(
        `Set start:debug in ${escapeName(path)} to use --inspect=127.0.0.1:${port}; the manifest could not be read, so the script was left unchanged.`,
      );
      return [];
    }
    if (source === undefined) continue;
    const contents = rewriteInspectorScript(
      source,
      runtime === 'deno' ? 'tasks' : 'scripts',
      port,
      previous,
    );
    if (contents !== undefined) return [{ path, contents, managed: true }];
    notice(
      `Set start:debug in ${escapeName(path)} to use --inspect=127.0.0.1:${port}; its inspector token was not present exactly once, so the script was left unchanged.`,
    );
    return [];
  }
  notice(
    `Set start:debug in ${escapeName(dir)} to use --inspect=127.0.0.1:${port}; no member manifest was found.`,
  );
  return [];
}

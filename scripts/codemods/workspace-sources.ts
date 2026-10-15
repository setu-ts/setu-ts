/**
 * Maps a workspace specifier (`@setu-ts/<name>[/subpath]`) to the member's source file, from the
 * same `deno.json` export map the Node build reads. Shared by the Vitest config and by the module
 * hook child processes load, so a test and the subprocess it spawns resolve one package graph.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceMembers } from '../lib/workspace.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workspace = await workspaceMembers(root);
const members = new Map(
  workspace.map((member) => {
    const dir = resolve(root, member);
    const manifest = JSON.parse(readFileSync(resolve(dir, 'deno.json'), 'utf8'));
    const exports =
      typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports;
    return [manifest.name, { dir, exports: exports as Record<string, string> }] as const;
  }),
);

/** Resolve package tests to the same source export map used by the Node build. */
export function sourceExport(specifier: string): string | null {
  const match = /^(@setu-ts\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const member = members.get(match[1]!);
  const target = member?.exports[match[2] ? '.' + match[2] : '.'];
  return member && target ? resolve(member.dir, target) : null;
}

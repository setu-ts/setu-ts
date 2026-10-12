/** Project and workspace-root detection for commands that write. */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';
import { joinPath } from './file-writer.ts';
import { readJsonManifest } from './manifest-reader.ts';

/** A manifest found at a project boundary. */
export interface ManifestFile {
  readonly path: string;
  readonly format: 'json' | 'jsonc';
}

/** Classification of a directory before a writing command operates on it. */
export type ProjectDetection =
  | { readonly kind: 'project'; readonly manifests: readonly ManifestFile[] }
  | { readonly kind: 'workspace-root'; readonly marker: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the marker that makes a directory a workspace root. */
export async function findWorkspaceMarker(
  fs: IFileSystem,
  dir: string,
): Promise<string | undefined> {
  const workspacePath = joinPath(dir, 'setu.workspace.json');
  try {
    await fs.stat(workspacePath);
    return 'it has a setu.workspace.json';
  } catch (cause) {
    if (!isMissingPath(cause)) return `cannot inspect ${workspacePath}`;
  }

  for (
    const { file, key } of [
      { file: 'deno.json', key: 'workspace' },
      { file: 'deno.jsonc', key: 'workspace' },
      { file: 'package.json', key: 'workspaces' },
    ] as const
  ) {
    const read = await readJsonManifest(fs, joinPath(dir, file));
    if (read.kind === 'ok' && isRecord(read.value) && key in read.value) {
      return `its ${file} declares "${key}"`;
    }
  }
  return undefined;
}

/** Detects whether a directory is a project, workspace root, or neither. */
export async function detectProject(fs: IFileSystem, dir: string): Promise<ProjectDetection> {
  const marker = await findWorkspaceMarker(fs, dir);
  if (marker !== undefined) return { kind: 'workspace-root', marker };

  const manifests: ManifestFile[] = [];
  for (const file of ['deno.json', 'deno.jsonc', 'package.json'] as const) {
    const path = joinPath(dir, file);
    const read = await readJsonManifest(fs, path);
    if (read.kind === 'unreadable') {
      return { kind: 'unreadable', path, reason: read.reason };
    }
    if (read.kind === 'ok') manifests.push({ path, format: read.format });
  }
  return manifests.length === 0 ? { kind: 'none' } : { kind: 'project', manifests };
}

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { firstDuplicatePath } from '../../../src/utils/file-writer.ts';
import { workspaceRootFiles } from '../../../src/workspace/root-files.ts';
import { WORKSPACE_MANIFEST, WORKSPACE_VERSION } from '../../../src/workspace/manifest.ts';

/**
 * Reads one emitted file's contents.
 *
 * @param path - The path to read
 * @returns Its contents
 */
function contentsOf(path: string): string {
  const file = workspaceRootFiles('acme', 3000).find((candidate) => candidate.path === path);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('workspaceRootFiles', () => {
  it('emits the four root files and nothing else', () => {
    expect(workspaceRootFiles('acme', 3000).map((file) => file.path).sort()).toEqual([
      '.gitignore',
      'README.md',
      WORKSPACE_MANIFEST,
      'deno.json',
    ].sort());
  });

  it('plans no path twice', () => {
    expect(firstDuplicatePath(workspaceRootFiles('acme', 3000))).toBeUndefined();
  });

  // A GLOB, parsed rather than substring-matched: this is what makes adding a
  // member touch no file the developer owns.
  it('declares members by glob so the root is never rewritten', () => {
    const manifest = JSON.parse(contentsOf('deno.json')) as { workspace?: string[] };
    expect(manifest.workspace).toEqual(['./apps/*']);
  });

  it('gives the root a task that runs every member', () => {
    const manifest = JSON.parse(contentsOf('deno.json')) as { tasks?: Record<string, string> };
    expect(manifest.tasks?.['dev']).toBe('deno task --recursive start');
  });

  // Framework pins belong to members: `setu generate` detects installed plugins
  // by reading ONE directory's manifest and never walks up, so pins living only
  // here would make every gated schematic refuse inside a member.
  it('pins no framework package at the root', () => {
    expect(contentsOf('deno.json')).not.toContain('@setu-ts/');
  });

  it('starts the workspace manifest empty, at the supported version', () => {
    const manifest = JSON.parse(contentsOf(WORKSPACE_MANIFEST)) as {
      version: number;
      basePort: number;
      members: unknown[];
    };
    expect(manifest).toEqual({ version: WORKSPACE_VERSION, basePort: 3000, members: [] });
  });

  it('records the base port it was given', () => {
    const file = workspaceRootFiles('acme', 4100).find((f) => f.path === WORKSPACE_MANIFEST);
    expect(JSON.parse(file?.contents ?? '{}')).toMatchObject({ basePort: 4100 });
  });

  it('names the workspace and the add-a-service command in its README', () => {
    const readme = contentsOf('README.md');
    expect(readme).toContain('# acme');
    expect(readme).toContain('setu generate app orders');
    expect(readme).toContain(WORKSPACE_MANIFEST);
  });
});

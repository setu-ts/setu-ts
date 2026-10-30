import { expect, it } from 'vitest';
import { BUN_WORKSPACE_CONFIG, planBunWorkspaceLinker } from '../../../src/workspace/library.ts';
import { workspaceRootFiles } from '../../../src/workspace/root-files.ts';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';

it('creates hoisted Bun roots and no configuration for npm or Deno', () => {
  for (const runtime of ['bun', 'node', 'deno'] as const) {
    const files = workspaceRootFiles(
      'acme',
      3000,
      transportSpec('http'),
      workspaceProfile(runtime),
    );
    expect(files.find((file) => file.path === 'bunfig.toml')?.contents).toBe(
      runtime === 'bun' ? BUN_WORKSPACE_CONFIG : undefined,
    );
    const ignored = files.find((file) => file.path === '.gitignore')!.contents;
    expect(ignored).toContain('apps/*/build/');
    if (runtime !== 'deno') expect(ignored).toContain('apps/*/dist/');
  }
});

it('plans the four older-workspace cases without rewriting TOML', () => {
  expect(planBunWorkspaceLinker(undefined)).toEqual({
    kind: 'update',
    file: {
      path: 'bunfig.toml',
      contents: BUN_WORKSPACE_CONFIG,
      managed: true,
    },
  });
  for (const source of [
    BUN_WORKSPACE_CONFIG,
    "[install] # layout\nlinker = 'hoisted' # preserve\n[run]\nbun = true\n",
  ]) {
    expect(planBunWorkspaceLinker(source)).toEqual({ kind: 'unchanged' });
  }
  for (const source of [
    '[install]\nlinker = "isolated"',
    '[install]\ncache = true',
    '[run]\nlinker = "hoisted"',
    '[install]\nlinker = "hoisted"\nlinker = "isolated"',
  ]) {
    expect(planBunWorkspaceLinker(source)).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('linker = "hoisted"'),
    });
  }
  // PR #515 review: a multiline string holding an `[install]` / hoisted pair is not
  // configuration, and a line scan cannot tell — refused as ambiguous, both quote styles.
  for (const quote of ['"""', "'''"]) {
    const source = `note = ${quote}\n[install]\nlinker = "hoisted"\n${quote}\n[install]\ncache = true\n`;
    expect(planBunWorkspaceLinker(source)).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('TOML multiline string'),
    });
  }
});

/** Tests the authored framework/app inventory independently of generated manifests. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceApps, workspaceMembers } from '../../scripts/lib/workspace.ts';

const roots: string[] = [];
async function fixture(
  yaml = 'packages:\n  - packages/z\n  - ./packages/starters/a\n  - apps/*\n',
): Promise<string> {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp('.tmp/workspace-');
  roots.push(root);
  await writeFile(`${root}/pnpm-workspace.yaml`, yaml);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

describe('workspace inventory', () => {
  it('retains framework order and separates apps', async () => {
    const root = await fixture();
    expect(await workspaceMembers(root)).toEqual(['packages/z', 'packages/starters/a']);
    for (const name of ['z', 'a', 'without-manifest', 'manifest-is-directory']) {
      await mkdir(`${root}/apps/${name}`, { recursive: true });
    }
    for (const name of ['z', 'a']) await writeFile(`${root}/apps/${name}/package.json`, '{}');
    await mkdir(`${root}/apps/manifest-is-directory/package.json`);
    await writeFile(`${root}/apps/readme`, 'not an app');
    expect(await workspaceApps(root)).toEqual(['apps/a', 'apps/z']);
  });

  it('names missing or malformed YAML', async () => {
    const root = await fixture('packages: [');
    await expect(workspaceMembers(root)).rejects.toThrow(
      'pnpm-workspace.yaml: cannot read workspace YAML',
    );
    await rm(`${root}/pnpm-workspace.yaml`);
    await expect(workspaceMembers(root)).rejects.toThrow(
      'pnpm-workspace.yaml: cannot read workspace YAML',
    );
  });

  it.each(['null', '[]', '{}', 'packages: false', 'packages: [3]'])(
    'refuses invalid inventory %s',
    async (yaml) => {
      await expect(workspaceMembers(await fixture(yaml))).rejects.toThrow(
        'expected a packages list of strings',
      );
    },
  );

  it('refuses app discovery without the authored apps glob', async () => {
    await expect(workspaceApps(await fixture('packages: [packages/a]'))).rejects.toThrow(
      'expected apps/*',
    );
  });

  it('defaults to the real workspace and accepts injected reads', async () => {
    expect(await workspaceMembers()).toContain('packages/common');
    expect(await workspaceMembers('.', () => Promise.resolve('packages: [packages/only]'))).toEqual(
      ['packages/only'],
    );
  });
});

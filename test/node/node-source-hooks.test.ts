import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedForImporter, resolve } from '../node-source-hooks.ts';
import { tempDir } from '../node-helpers.ts';

/** A `next` that records the deferral instead of resolving anything. */
const deferred = (specifier: string) => ({ url: `deferred:${specifier}` });

/** A project under `.tmp/` with `@setu-ts/kernel` installed, plus a bare file. */
async function fixture(): Promise<{ root: string; project: string; bare: string }> {
  const root = await tempDir({ prefix: 'source-hooks-' });
  const project = join(root, 'proj');
  await mkdir(join(project, 'node_modules', '@setu-ts', 'kernel'), { recursive: true });
  await writeFile(join(project, 'node_modules', '@setu-ts', 'kernel', 'package.json'), '{}');
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(root, 'bare'), { recursive: true });
  return { root, project, bare: join(root, 'bare') };
}

describe('the test source redirect', () => {
  it('leaves an installed project to Node, so a packaging defect is not hidden', async () => {
    const { root, project } = await fixture();
    try {
      const parent = pathToFileURL(join(project, 'src', 'config.ts')).href;
      expect(installedForImporter(parent, '@setu-ts/kernel')).toBe(true);
      expect(resolve('@setu-ts/kernel', { parentURL: parent }, deferred).url)
        .toBe('deferred:@setu-ts/kernel');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('still redirects a package the project has not installed', async () => {
    const { root, project } = await fixture();
    try {
      const parent = pathToFileURL(join(project, 'src', 'config.ts')).href;
      expect(installedForImporter(parent, '@setu-ts/runtime')).toBe(false);
      const resolved = resolve('@setu-ts/runtime', { parentURL: parent }, deferred);
      expect(resolved).toMatchObject({ shortCircuit: true });
      expect(resolved.url).toContain('/packages/runtime/src/');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('redirects a temp file with no install, and the repository source', async () => {
    const { root, bare } = await fixture();
    try {
      expect(installedForImporter(pathToFileURL(join(bare, 'a.ts')).href, '@setu-ts/kernel'))
        .toBe(false);
      const repo = pathToFileURL(join(process.cwd(), 'packages/cli/src/cli.ts')).href;
      expect(installedForImporter(repo, '@setu-ts/kernel')).toBe(false);
      expect(resolve('@setu-ts/kernel', { parentURL: repo }, deferred).url)
        .toContain('/packages/kernel/src/');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('redirects when there is no importer or it is not a file', () => {
    expect(installedForImporter(undefined, '@setu-ts/kernel')).toBe(false);
    expect(installedForImporter('data:text/javascript,0', '@setu-ts/kernel')).toBe(false);
  });

  it('defers a specifier that is not a workspace package', () => {
    expect(resolve('node:fs', {}, deferred).url).toBe('deferred:node:fs');
  });
});

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  importFromProject,
  importProjectModule,
  nearestTsconfig,
} from '../../src/utils/ts-loader.ts';

/** An `exists` seam over a fixed set of present paths, recording every probe. */
function probe(present: readonly string[]) {
  const asked: string[] = [];
  const set = new Set(present);
  return {
    asked,
    exists: (path: string) => {
      asked.push(path);
      return set.has(path);
    },
  };
}

describe('nearestTsconfig', () => {
  it('finds the tsconfig beside the module', () => {
    const { exists } = probe(['/app/tsconfig.json']);
    expect(nearestTsconfig('file:///app/setu.config.ts', '/app', exists)).toBe(
      '/app/tsconfig.json',
    );
  });

  it('walks up inside the project and prefers the closest one', () => {
    const { exists } = probe(['/repo/tsconfig.json', '/repo/apps/api/tsconfig.json']);
    expect(nearestTsconfig('file:///repo/apps/api/src/x.ts', '/repo', exists)).toBe(
      '/repo/apps/api/tsconfig.json',
    );
    expect(nearestTsconfig('file:///repo/libs/x/mod.ts', '/repo', exists)).toBe(
      '/repo/tsconfig.json',
    );
  });

  it('reaches a custom schematic project root two levels up', () => {
    const { exists } = probe(['/proj/tsconfig.json']);
    expect(nearestTsconfig('file:///proj/.setu-ts/schematics/x.ts', '/proj', exists)).toBe(
      '/proj/tsconfig.json',
    );
  });

  // M111d audit F2: a `tsconfig.json` is code routing — its `paths` decide which
  // file an `@setu-ts/*` import runs — so one planted ABOVE the project must
  // never be read, however many directories the walk would have to climb.
  it('never reads a tsconfig above the project root', () => {
    const { asked, exists } = probe(['/shared/tsconfig.json', '/tsconfig.json']);
    expect(nearestTsconfig('file:///shared/proj/setu.config.ts', '/shared/proj', exists)).toBe(
      false,
    );
    expect(asked).toEqual(['/shared/proj/tsconfig.json']);
  });

  it('holds a module outside its root, or with no root, to its own directory', () => {
    const outside = probe(['/elsewhere/tsconfig.json', '/tsconfig.json']);
    expect(nearestTsconfig('file:///elsewhere/x/mod.ts', '/proj', outside.exists)).toBe(false);
    expect(outside.asked).toEqual(['/elsewhere/x/tsconfig.json']);

    const noRoot = probe(['/a/tsconfig.json']);
    expect(nearestTsconfig('file:///a/b/c.ts', undefined, noRoot.exists)).toBe(false);
    expect(noRoot.asked).toEqual(['/a/b/tsconfig.json']);
  });

  it('does not treat a sibling sharing the root as a prefix as inside it', () => {
    const { asked, exists } = probe(['/proj/tsconfig.json']);
    expect(nearestTsconfig('file:///proj-other/x.ts', '/proj', exists)).toBe(false);
    expect(asked).toEqual(['/proj-other/tsconfig.json']);
  });
});

describe('importFromProject real tsx resolution', () => {
  it('review 3 verifies the real requested-package not-found message shape', async () => {
    await fs.mkdir('.tmp', { recursive: true });
    const root = resolve(await fs.mkdtemp('.tmp/m129-missing-package-'));
    try {
      await fs.writeFile(`${root}/package.json`, '{"type":"module"}');
      await expect(importFromProject('@setu-ts/not-installed-m129', root)).rejects.toMatchObject({
        code: 'ERR_MODULE_NOT_FOUND',
        message: expect.stringMatching(
          /^Cannot find package '@setu-ts\/not-installed-m129' imported from /,
        ),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable tsx dependency for both import entry points', async () => {
    vi.resetModules();
    vi.doMock('tsx/esm/api', () => {
      throw new Error('tsx is unavailable');
    });
    try {
      const loaders = await import('../../src/utils/ts-loader.ts');
      for (const operation of [
        () => loaders.importFromProject('@setu-ts/sdk', '/app'),
        () => loaders.importProjectModule('file:///app/setu.config.ts', '/app'),
      ])
        await expect(operation()).rejects.toMatchObject({
          name: 'OptionalDependencyUnavailableError',
          dependency: 'tsx',
          cause: expect.any(Error),
        });
    } finally {
      vi.doUnmock('tsx/esm/api');
      vi.resetModules();
    }
  });
  for (const manifest of ['package.json', 'deno.json']) {
    it(`loads the fixture's own sdk relative to ${manifest}`, async () => {
      await fs.mkdir('.tmp', { recursive: true });
      const root = resolve(await fs.mkdtemp('.tmp/m129-loader-'));
      try {
        await fs.writeFile(`${root}/${manifest}`, JSON.stringify({ type: 'module' }));
        const pkg = `${root}/node_modules/@setu-ts/sdk`;
        await fs.mkdir(pkg, { recursive: true });
        await fs.writeFile(
          `${pkg}/package.json`,
          JSON.stringify({ name: '@setu-ts/sdk', type: 'module', exports: './index.js' }),
        );
        await fs.writeFile(
          `${pkg}/index.js`,
          "export const fixture = 'project-owned'; export function generateOpenApiClient() { return 'fixture client'; }",
        );
        const module = await importFromProject('@setu-ts/sdk', root);
        expect(module['fixture']).toBe('project-owned');
        expect(typeof module['generateOpenApiClient']).toBe('function');
        await fs.writeFile(`${root}/probe.ts`, "export const moduleMarker = 'project-module';");
        expect(
          (await importProjectModule(new URL(`file://${root}/probe.ts`).href, root))[
            'moduleMarker'
          ],
        ).toBe('project-module');
        await expect(importFromProject('@setu-ts/not-installed-m129', root)).rejects.toHaveProperty(
          'code',
          'ERR_MODULE_NOT_FOUND',
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
  it('preserves initialization errors from an installed package', async () => {
    await fs.mkdir('.tmp', { recursive: true });
    const root = resolve(await fs.mkdtemp('.tmp/m129-loader-'));
    try {
      await fs.writeFile(`${root}/package.json`, '{"type":"module"}');
      const pkg = `${root}/node_modules/@setu-ts/sdk`;
      await fs.mkdir(pkg, { recursive: true });
      await fs.writeFile(`${pkg}/package.json`, '{"type":"module","exports":"./index.js"}');
      await fs.writeFile(`${pkg}/index.js`, "throw new Error('installed sdk failed at load');");
      await expect(importFromProject('@setu-ts/sdk', root)).rejects.toThrow(
        'installed sdk failed at load',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

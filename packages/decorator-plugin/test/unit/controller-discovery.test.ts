import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';

import { discoverControllers } from '../../src/discovery/controller-discovery.ts';
import type { ModuleImporter } from '../../src/discovery/controller-discovery.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeFileSystem, createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A file system whose `readdir`/`stat` reject (simulates a missing directory). */
function throwingFs(): IFileSystem {
  const err = () => Promise.reject(new Error('ENOENT: no such directory'));
  return {
    readdir: err,
    readFile: err,
    stat: err,
    writeFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
  };
}

/** Builds a fake importer that simulates a controller module per file. */
function fakeControllerImporter(): { importer: ModuleImporter; count: () => number } {
  let n = 0;
  const importer: ModuleImporter = () => {
    n++;
    class DiscoveredFake {
      static _n = n;
    }
    metadataStore.mergeController(DiscoveredFake, { path: '/fake' });
    return Promise.resolve();
  };
  return { importer, count: () => n };
}

// Whether the runner can perform a real `import()` of a `file://` URL. The
// real-`import()` discovery path is an external I/O line; under
// non-interactive `deno test -P` (no read/import grant) it is skipped
// (CLAUDE.md: an external I/O line may stay behind a guarded test, but the
// branching logic around it is still exercised by the injectable-importer
// tests below). Probed synchronously via the permission API to avoid a
// circular top-level `await import(import.meta.url)`.
function probeImportPermission(): boolean {
  const g = globalThis as {
    Deno?: { permissions?: { querySync?: (p: unknown) => { state: string } } };
  };
  const deno = g.Deno;
  if (deno?.permissions?.querySync === undefined) {
    return false;
  }
  try {
    return deno.permissions.querySync({ name: 'import' }).state === 'granted';
  } catch {
    return false;
  }
}
const realImportAvailable = probeImportPermission();

describe('discoverControllers', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it({
    name: 'discovers a real decorated controller via the default import() path',
    ignore: !realImportAvailable,
  }, async () => {
    const sampleDir = new URL('../fixtures/discovery-sample/', import.meta.url).pathname.replace(
      /\/$/,
      '',
    );
    const fs = createFakeFileSystem({ [`${sampleDir}/user-controller.ts`]: '' });
    const result = await discoverControllers(
      { path: sampleDir },
      createFakeRuntime({ fs }),
      metadataStore,
    );
    expect(result.errors).toEqual([]);
    expect(
      result.controllers.some((c) => (c as { name?: string }).name === 'DiscoveredUserController'),
    ).toBe(true);
  });

  it('skips files matching the default test/spec exclude patterns', async () => {
    const fs = createFakeFileSystem({ '/d/ctrl.ts': '', '/d/ctrl.test.ts': '' });
    const { importer, count } = fakeControllerImporter();
    const result = await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(count()).toBe(1);
    expect(result.controllers).toHaveLength(1);
  });

  it('honors a custom exclude pattern', async () => {
    const fs = createFakeFileSystem({ '/d/keep.ts': '', '/d/drop.skip.ts': '' });
    const { importer } = fakeControllerImporter();
    const result = await discoverControllers(
      { path: '/d', exclude: ['*.skip.ts'] },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(result.controllers).toHaveLength(1);
  });

  it('only includes configured extensions', async () => {
    const fs = createFakeFileSystem({ '/d/a.ts': '', '/d/b.md': '', '/d/c.js': '' });
    const { importer, count } = fakeControllerImporter();
    await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(count()).toBe(2); // a.ts and c.js; b.md excluded
  });

  it('walks nested directories', async () => {
    const fs = createFakeFileSystem({ '/d/sub/nested.ts': '', '/d/top.ts': '' });
    const { importer, count } = fakeControllerImporter();
    await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(count()).toBe(2);
  });

  it('skips node_modules and hidden directories', async () => {
    const fs = createFakeFileSystem({
      '/d/node_modules/x.ts': '',
      '/d/.hidden/y.ts': '',
      '/d/keep.ts': '',
    });
    const { importer, count } = fakeControllerImporter();
    await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(count()).toBe(1);
  });

  it('records an import error and continues with remaining files', async () => {
    const fs = createFakeFileSystem({ '/d/good.ts': '', '/d/bad.ts': '' });
    const importer: ModuleImporter = (spec) => {
      if (spec.includes('bad')) {
        return Promise.reject(new Error('boom'));
      }
      class OkCtrl {}
      metadataStore.mergeController(OkCtrl, { path: '/ok' });
      return Promise.resolve();
    };
    const result = await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(result.controllers).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toContain('bad.ts');
  });

  it('returns an error when the directory cannot be read', async () => {
    const runtime: IRuntimeServices = createFakeRuntime({ fs: throwingFs() });
    const result = await discoverControllers({ path: '/missing' }, runtime, metadataStore);
    expect(result.controllers).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('returns an error when runtime.fs is absent', async () => {
    const result = await discoverControllers(
      { path: '/d' },
      createFakeRuntime(),
      metadataStore,
    );
    expect(result.controllers).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('File system');
  });

  it('discovers services too', async () => {
    const fs = createFakeFileSystem({ '/d/svc.ts': '' });
    const importer: ModuleImporter = () => {
      class Svc {}
      metadataStore.mergeService(Svc, { token: 'svc' });
      return Promise.resolve();
    };
    const result = await discoverControllers(
      { path: '/d' },
      createFakeRuntime({ fs }),
      metadataStore,
      importer,
    );
    expect(result.services).toHaveLength(1);
  });
});

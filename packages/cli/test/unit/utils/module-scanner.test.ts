/**
 * Unit tests for domain-module discovery.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import {
  MODULES_DIR,
  readModuleNames,
  scanModules,
  scanModuleArtifacts,
} from '../../../src/utils/module-scanner.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { MAX_EXISTING_FILE_BYTES } from '../../../src/utils/file-writer.ts';
import { deriveNames } from '../../../src/utils/names.ts';

/** A directory stat, shaped as the real runtime adapters report one. */
const DIR_STAT: StatResult = { isFile: false, isDirectory: true, size: 0 };
/** A file stat. */
const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };

/**
 * Builds a filesystem double over a listing plus a per-path stat map.
 *
 * Keyed by the path suffix BELOW the modules root, so a test can describe both a
 * directory and the files inside it — which the scanner has to probe, because a
 * directory alone does not make a module.
 *
 * @param entries - What `readdir` returns, or an error to reject with
 * @param stats - Path suffix below the modules root → stat, or an error
 * @returns The double, satisfying the required members of IFileSystem
 */
function fsWith(
  entries: readonly string[] | Error,
  stats: Readonly<Record<string, StatResult | Error>> = {},
): IFileSystem {
  return {
    realPath: (path) => Promise.resolve(path),
    readdir: (_path: string) =>
      entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries),
    stat: (path: string) => {
      const key = path.slice(path.indexOf(MODULES_DIR) + MODULES_DIR.length + 1);
      const result = stats[key];
      if (result !== undefined) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
      // Unlisted: one segment is a directory, anything deeper is a file — the
      // shape of a well-formed module the CLI generated.
      return Promise.resolve(key.includes('/') ? FILE_STAT : DIR_STAT);
    },
    readFile: (path) => {
      const file = path.slice(path.lastIndexOf('/') + 1);
      const [name, kind] = file.split('.');
      const suffix =
        kind === 'controller' ? 'Controller' : kind === 'service' ? 'Service' : 'Module';
      return Promise.resolve(
        new TextEncoder().encode(`export class ${deriveNames(name ?? '').pascal}${suffix} {}`),
      );
    },
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

/** A stat rejection shaped like a real runtime's missing-path error. */
const MISSING = Object.assign(new Error('NotFound'), { name: 'NotFound' });

describe('functional module scanning', () => {
  it('reports an index that is not a regular file without reading it', async () => {
    const fs = createFakeFs({ '/app/src/modules/billing/billing.controller.ts': '' });
    const probe: IFileSystem = {
      ...fs,
      stat: (path) => (path.endsWith('/index.ts') ? Promise.resolve(DIR_STAT) : fs.stat(path)),
      readFile: () => Promise.reject(new Error('must not read')),
    };
    expect(await scanModules(probe, '/app', 'functional')).toEqual({
      names: [],
      skipped: [
        {
          kind: 'missing-export',
          name: 'billing',
          path: 'src/modules/billing',
          missing: 'registerBillingModule',
        },
      ],
      rejected: [],
    });
  });
  for (const oversized of [false, true]) {
    it(`${oversized ? 'skips and reports' : 'admits'} an index ${oversized ? 'over' : 'at'} the read limit`, async () => {
      const index = '/app/src/modules/billing/index.ts';
      const fs = createFakeFs({
        '/app/src/modules/billing/billing.controller.ts': '',
        [index]: 'export function registerBillingModule() {}',
      });
      const reads: string[] = [];
      const probe: IFileSystem = {
        ...fs,
        stat: async (path) => ({
          ...(await fs.stat(path)),
          ...(path === index ? { size: MAX_EXISTING_FILE_BYTES + Number(oversized) } : {}),
        }),
        readFile: (path) => {
          reads.push(path);
          return fs.readFile(path);
        },
      };
      const scan = await scanModules(probe, '/app', 'functional');
      expect(scan.names).toEqual(oversized ? [] : ['billing']);
      expect(scan.skipped).toEqual(
        oversized
          ? [
              {
                kind: 'missing-export',
                name: 'billing',
                path: 'src/modules/billing',
                missing: 'registerBillingModule',
              },
            ]
          : [],
      );
      expect(reads).toEqual(oversized ? [] : [index]);
    });
  }
  it('admits exported registrars and reports invalid declarations while ignoring shared helpers', async () => {
    const fs = createFakeFs({
      '/app/src/modules/zebra/zebra.controller.ts': '',
      '/app/src/modules/zebra/index.ts': 'export function registerZebraModule() {}',
      '/app/src/modules/billing/billing.controller.ts': '',
      '/app/src/modules/billing/index.ts': 'export { registerBillingModule } from "./register.ts";',
      '/app/src/modules/broken/broken.controller.ts': '',
      '/app/src/modules/broken/index.ts': '// registerBrokenModule',
      '/app/src/modules/missing/missing.controller.ts': '',
      '/app/src/modules/legacy/legacy.service.ts': '',
      '/app/src/modules/legacy/index.ts': 'export * from "./legacy.service.ts";',
      '/app/src/modules/shared/helper.ts': '',
    });
    const scan = await scanModules(fs, '/app', 'functional');
    expect(scan.names).toEqual(['billing', 'zebra']);
    expect(scan.skipped.map((skip) => skip.name)).toEqual(['broken', 'legacy', 'missing']);
    expect(scan.skipped[0]?.missing).toBe('registerBrokenModule');
    expect((await scanModules(fs, '/app', 'class-based')).names).toEqual([]);
    const unreadable = { ...fs, readFile: () => Promise.reject(new Error('unreadable')) };
    expect((await scanModules(unreadable, '/app', 'functional')).names).toEqual([]);
  });
  it('scans sibling routes and controllers by the symbols their index imports', async () => {
    const fs = createFakeFs({
      '/app/src/modules/invoices/invoices.controller.ts':
        'export function registerInvoicesRoutes() {}',
      '/app/src/modules/invoices/summary.controller.ts':
        'export function registerSummaryRoutes() {}',
      '/app/src/modules/invoices/billing.controller.ts':
        'export function registerBillingRoutes() {}',
      '/app/src/modules/invoices/broken.controller.ts': 'export const broken = 1;',
      '/app/src/modules/invoices/pricing.service.ts': '',
    });
    const scan = await scanModuleArtifacts(fs, '/app', 'invoices');
    expect(scan.artifacts).toEqual({ controller: ['billing', 'invoices', 'summary'] });
    expect(scan.skipped).toEqual([
      { path: 'src/modules/invoices/broken.controller.ts', missing: ['registerBrokenRoutes'] },
    ]);
  });
});

describe('class-based module exports', () => {
  for (const kind of ['module'] as const) {
    for (const failure of [
      'missing-export',
      'oversized',
      'non-regular',
      'unreadable',
      'stat-error',
    ] as const) {
      it(`reports a ${failure} ${kind} and never calls it legacy`, async () => {
        const files = {
          '/app/src/modules/orders/orders.controller.ts': 'export class OrdersController {}',
          '/app/src/modules/orders/orders.service.ts': 'export class OrdersService {}',
          '/app/src/modules/orders/orders.module.ts': 'export class OrdersModule {}',
        };
        const base = createFakeFs(files);
        const path = `/app/src/modules/orders/orders.${kind}.ts`;
        const fs: IFileSystem = {
          ...base,
          stat: (file) =>
            file !== path
              ? base.stat(file)
              : failure === 'stat-error'
                ? Promise.reject(new Error('EACCES'))
                : failure === 'oversized'
                  ? Promise.resolve({ ...FILE_STAT, size: MAX_EXISTING_FILE_BYTES + 1 })
                  : failure === 'non-regular'
                    ? Promise.resolve({ isFile: false, isDirectory: false, size: 0 })
                    : base.stat(file),
          readFile: (file) =>
            file !== path
              ? base.readFile(file)
              : failure === 'unreadable'
                ? Promise.reject(new Error('EIO'))
                : failure === 'missing-export'
                  ? Promise.resolve(new TextEncoder().encode('// no exports'))
                  : Promise.reject(new Error('must not read rejected file')),
        };
        const symbol = `Orders${kind[0].toUpperCase()}${kind.slice(1)}`;
        expect(await scanModules(fs, '/app', 'class-based')).toEqual({
          names: [],
          rejected: [],
          skipped: [
            { kind: 'missing-export', name: 'orders', path: 'src/modules/orders', missing: symbol },
          ],
        });
      });
    }
  }
  it('reports an absent declaration as legacy when the old controller and service files remain', async () => {
    const fs = createFakeFs({
      '/app/src/modules/orders/orders.controller.ts': 'export class OrdersController {}',
      '/app/src/modules/orders/orders.service.ts': 'export class OrdersService {}',
    });
    expect(await scanModules(fs, '/app')).toEqual({
      names: [],
      rejected: [],
      skipped: [
        {
          kind: 'legacy',
          name: 'orders',
          path: 'src/modules/orders',
          missing: 'orders.module.ts',
        },
      ],
    });
  });
});

describe('readModuleNames', () => {
  it('returns directory names sorted', () => {
    // Enumeration order is filesystem-defined; the sort is what makes the
    // rendered barrel stable across machines.
    return readModuleNames(fsWith(['user', 'billing', 'order']), '/app').then((names) => {
      expect(names).toEqual(['billing', 'order', 'user']);
    });
  });

  it('excludes files, so the barrel never imports from index.ts', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'index.ts'], { 'index.ts': FILE_STAT }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('returns an empty list when src/modules does not exist', async () => {
    // A project that has never generated a module is the common case, not an
    // error — every other schematic must keep working there.
    const names = await readModuleNames(fsWith(new Error('NotFound')), '/app');

    expect(names).toEqual([]);
  });

  it('skips an entry whose stat fails and keeps the rest', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'vanished'], { vanished: new Error('NotFound') }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('returns an empty list for an empty directory', async () => {
    expect(await readModuleNames(fsWith([]), '/app')).toEqual([]);
  });

  it('excludes a directory that is not a generated module', async () => {
    // A `shared/` helper folder under src/modules is a natural thing to create.
    // Treating it as a module makes the regenerated barrel import
    // `./shared/shared.controller.ts`, which does not exist — so the developer's
    // project stops compiling, from a command that reported success.
    const names = await readModuleNames(
      fsWith(['user', 'shared'], {
        'shared/shared.module.ts': MISSING,
        'shared/shared.controller.ts': MISSING,
        'shared/shared.service.ts': MISSING,
      }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('admits a declared module independently of its controller location', async () => {
    // The declaration supplies module identity; file locations do not.
    const names = await readModuleNames(
      fsWith(['user', 'half'], { 'half/half.controller.ts': MISSING }),
      '/app',
    );

    expect(names).toEqual(['half', 'user']);
  });

  it('admits a declared module independently of its service location', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'half'], { 'half/half.service.ts': MISSING }),
      '/app',
    );

    expect(names).toEqual(['half', 'user']);
  });

  it('reports a legacy generated module missing its declaration', async () => {
    const scan = await scanModules(
      fsWith(['legacy'], { 'legacy/legacy.module.ts': MISSING }),
      '/app',
    );

    expect(scan.names).toEqual([]);
    expect(scan.skipped).toEqual([
      { kind: 'legacy', name: 'legacy', path: 'src/modules/legacy', missing: 'legacy.module.ts' },
    ]);
  });

  it('excludes a directory whose canonical paths are themselves directories', async () => {
    // A directory named `user.module.ts` satisfies a bare existence probe but
    // cannot be imported, so the check must require a FILE.
    const names = await readModuleNames(
      fsWith(['user'], { 'user/user.module.ts': DIR_STAT }),
      '/app',
    );

    expect(names).toEqual([]);
  });

  it('scans under the directory it is given', async () => {
    const seen: string[] = [];
    const fs = fsWith(['user']);
    const probe: IFileSystem = {
      ...fs,
      readdir: (path: string) => {
        seen.push(path);
        return fs.readdir(path);
      },
    };

    await readModuleNames(probe, '/somewhere/else');

    // `--dir` must root the scan, or the scan and the write disagree.
    expect(seen).toEqual([`/somewhere/else/${MODULES_DIR}`]);
  });
});

it('sorts multiple skipped legacy modules independently of filesystem enumeration', async () => {
  const result = await scanModules(
    fsWith(['zeta', 'alpha'], {
      'zeta/zeta.module.ts': MISSING,
      'alpha/alpha.module.ts': MISSING,
    }),
    '/app',
  );
  expect(result.skipped.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
});

describe('module directory names', () => {
  // A directory name is spliced into an import specifier and an identifier in the
  // CLI-owned activation barrel, so a name that does not round-trip through
  // `deriveNames` is rejected rather than written into generated source.
  const hostile = ['Bad_Name', '9lives', 'a"b', 'x\u001b[31m'];
  it('rejects a functional module whose name is not a kebab-case identifier', async () => {
    const files: Record<string, string> = {
      '/app/src/modules/billing/billing.controller.ts': '',
      '/app/src/modules/billing/index.ts': 'export function registerBillingModule() {}',
    };
    for (const name of hostile) {
      files[`/app/src/modules/${name}/${name}.controller.ts`] = '';
      files[`/app/src/modules/${name}/index.ts`] = 'export function registerX() {}';
    }
    const scan = await scanModules(createFakeFs(files), '/app', 'functional');
    expect(scan.names).toEqual(['billing']);
    expect(scan.skipped).toEqual([]);
    expect(scan.rejected).toEqual(hostile.map((name) => `${MODULES_DIR}/${name}`).sort());
  });
  it('rejects a class-based module whose name is not a kebab-case identifier', async () => {
    const scan = await scanModules(fsWith(['orders', ...hostile]), '/app', 'class-based');
    expect(scan.names).toEqual(['orders']);
    expect(scan.rejected).toEqual(hostile.map((name) => `${MODULES_DIR}/${name}`).sort());
  });
  it('does not reject a hostile directory that is not a module at all', async () => {
    const scan = await scanModules(
      createFakeFs({ '/app/src/modules/Bad_Name/helper.ts': '' }),
      '/app',
      'functional',
    );
    expect(scan.rejected).toEqual([]);
  });
});

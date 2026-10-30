import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { IFileSystem } from '@setu-ts/common';
import {
  readArtifactNames,
  DuplicateArtifactNameError,
} from '../../../src/utils/artifact-scanner.ts';
import { walkArtifactFiles } from '../../../src/utils/artifact-walk.ts';
import { artifactNames } from '../../../src/utils/artifact-path.ts';
import { scanModules, scanModuleArtifacts } from '../../../src/utils/module-scanner.ts';
import { FUNCTIONAL_CONTROLLERS_SEAM } from '../../../src/seams/http.ts';
import { renderFunctionalModuleIndex } from '../../../src/seams/modules.ts';
import { scanSeamSpecs } from '../../../src/seams/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { diagnoseProject } from '../../../src/diagnostics/diagnose.ts';
import { renderGenerateFindings } from '../../../src/diagnostics/render.ts';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const CONTROLLERS = FUNCTIONAL_CONTROLLERS_SEAM;

function syntax(source: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  expect(result.diagnostics).toEqual([]);
}

describe('recursive artifact identity', () => {
  it('uses the base filename for symbols while preserving nested paths for imports', async () => {
    expect(artifactNames('billing/invoices')).toEqual(deriveNames('invoices'));
    const fs = createFakeFs({
      '/app/src/controllers/billing/invoices.controller.ts':
        'export function registerInvoicesRoutes() {}',
      '/app/src/controllers/orders.controller.ts': 'export function registerOrdersRoutes() {}',
    });
    const scan = await readArtifactNames(fs, '/app', CONTROLLERS);
    expect(scan.names).toEqual(['billing/invoices', 'orders']);
    expect(scan.adopted).toEqual([
      {
        path: 'src/controllers/billing/invoices.controller.ts',
        barrel: 'src/controllers/index.ts',
      },
      { path: 'src/controllers/orders.controller.ts', barrel: 'src/controllers/index.ts' },
    ]);
    expect(scan.unreadable).toEqual([]);
    syntax(CONTROLLERS.renderBarrel({ controller: scan.names }));
  });

  it('admits artifacts at depth eight and reports deeper directories without entering them', async () => {
    const eight = 'a/b/c/d/e/f/g/h';
    const base = createFakeFs({
      [`/app/src/controllers/${eight}/orders.controller.ts`]:
        'export function registerOrdersRoutes() {}',
      [`/app/src/controllers/${eight}/ninth/invoices.controller.ts`]:
        'export function registerInvoicesRoutes() {}',
    });
    const listed: string[] = [];
    const fs: IFileSystem = {
      ...base,
      readdir: (path) => {
        listed.push(path);
        return base.readdir(path);
      },
    };
    const scan = await readArtifactNames(fs, '/app', CONTROLLERS);
    expect(scan.names).toEqual([`${eight}/orders`]);
    expect(scan.unreadable).toEqual([
      { path: `src/controllers/${eight}/ninth`, reason: 'depth-limit' },
    ]);
    expect(listed).not.toContain(`/app/src/controllers/${eight}/ninth`);
  });

  it('reports an unreadable nested directory, distinguishing an absent root', async () => {
    const base = createFakeFs({ '/app/src/controllers/billing/orders.controller.ts': '' });
    const fs: IFileSystem = {
      ...base,
      readdir: (path) =>
        path.endsWith('/billing') ? Promise.reject(new Error('EACCES')) : base.readdir(path),
    };
    expect((await walkArtifactFiles(fs, '/app', 'src/controllers')).unreadable).toEqual([
      { path: 'src/controllers/billing', reason: 'unreadable-directory' },
    ]);
    expect(await walkArtifactFiles(base, '/app', 'missing')).toEqual({ files: [], unreadable: [] });
    const missing: IFileSystem = {
      ...base,
      readdir: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
    };
    expect(await walkArtifactFiles(missing, '/app', 'src/controllers')).toEqual({
      files: [],
      unreadable: [],
    });
  });

  for (const name of ['orders', 'invoices']) {
    it(`refuses duplicate ${name} base names in different subfolders with a named error`, async () => {
      const symbol = `register${deriveNames(name).pascal}Routes`;
      const fs = createFakeFs({
        '/app/package.json': '{}',
        [`/app/src/controllers/a/${name}.controller.ts`]: `export function ${symbol}() {}`,
        [`/app/src/controllers/b/${name}.controller.ts`]: `export function ${symbol}() {}`,
      });
      await expect(readArtifactNames(fs, '/app', CONTROLLERS)).rejects.toMatchObject({
        name: 'DuplicateArtifactNameError',
        paths: [
          `src/controllers/a/${name}.controller.ts`,
          `src/controllers/b/${name}.controller.ts`,
        ],
      });
      const error = new DuplicateArtifactNameError('controller', [`a/${name}`, `b/${name}`]);
      expect(error.message).toBe(
        `Duplicate controller base name: a/${name}, b/${name}. Rename one file before generating or syncing.`,
      );
      for (const command of [['check'], ['sync'], ['g', 'controller', 'tracking']]) {
        const errors: string[] = [];
        expect(
          await runCli(command, {
            fs,
            cwd: '/app',
            now: () => 0,
            log: () => {},
            error: (line) => errors.push(line),
          }),
        ).toBe(1);
        expect(errors.join('\n')).toContain(`src/controllers/a/${name}.controller.ts`);
        expect(errors.join('\n')).toContain(`src/controllers/b/${name}.controller.ts`);
      }
      expect(fs.writes).toEqual([]);
    });

    it(`refuses generating another ${name} beside a nested controller, without writes`, async () => {
      const fs = createFakeFs({
        '/app/package.json': '{}',
        [`/app/src/controllers/billing/${name}.controller.ts`]: `export function register${deriveNames(name).pascal}Routes() {}`,
      });
      const errors: string[] = [];
      expect(
        await runCli(['g', 'controller', name], {
          fs,
          cwd: '/app',
          now: () => 0,
          log: () => {},
          error: (line) => errors.push(line),
        }),
      ).toBe(1);
      expect(errors.join('\n')).toContain(`the controller at billing/${name}`);
      expect(fs.writes).toEqual([]);
    });
  }

  it('rejects unsafe subfolder names before emitting an import', async () => {
    const fs = createFakeFs({
      "/app/src/controllers/q'y/orders.controller.ts": 'export function registerOrdersRoutes() {}',
    });
    const scan = await readArtifactNames(fs, '/app', CONTROLLERS);
    expect(scan.names).toEqual([]);
    expect(scan.skipped).toEqual([
      { path: "src/controllers/q'y/orders.controller.ts", missing: [], invalidName: true },
    ]);
  });

  it('does not require subfolder names to be identifiers', async () => {
    for (const folder of ['Billing', '_internal', '2026', 'with space']) {
      const fs = createFakeFs({
        [`/app/src/controllers/${folder}/orders.controller.ts`]:
          'export function registerOrdersRoutes() {}',
      });
      const scan = await readArtifactNames(fs, '/app', CONTROLLERS);
      expect(scan.names).toEqual([`${folder}/orders`]);
      const result = CONTROLLERS.renderBarrel({ controller: scan.names });
      expect(result).toContain(`from './${folder}/orders.controller.ts'`);
      syntax(result);
    }
  });
});

describe('recursive barrel rendering', () => {
  for (const installed of [new Set<string>(), new Set(['decorator-plugin', 'queue-plugin'])]) {
    for (const spec of scanSeamSpecs(installed)) {
      it(`${installed.has('decorator-plugin') ? 'class-based' : 'functional'} ${spec.schematic} keeps base symbols and nested import paths`, () => {
        const flat = spec.renderBarrel({ [spec.schematic]: ['orders'] });
        const nested = spec.renderBarrel({ [spec.schematic]: ['billing/orders'] });
        // The entire file must differ only in the module path; bindings and calls
        // keep their filename-derived symbols in every family.
        expect(nested).toBe(
          flat.replaceAll(`./orders${spec.suffix}`, `./billing/orders${spec.suffix}`),
        );
        syntax(nested);
      });
    }
  }

  it('pins the complete managed functional module index after a subfolder move', async () => {
    const fs = createFakeFs({
      '/app/src/modules/shipment/shipment.controller.ts':
        'export function registerShipmentRoutes() {}',
      '/app/src/modules/shipment/controllers/tracking.controller.ts':
        'export function registerTrackingRoutes() {}',
    });
    const scan = await scanModuleArtifacts(fs, '/app', 'shipment');
    expect(scan.artifacts).toEqual({ controller: ['controllers/tracking', 'shipment'] });
    const result = renderFunctionalModuleIndex(deriveNames('shipment'), scan.artifacts);
    expect(result)
      .toBe(`/** CLI-owned; regenerated by setu generate module or setu generate … --module <name>. */
import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { registerTrackingRoutes } from './controllers/tracking.controller.ts';
import { registerShipmentRoutes } from './shipment.controller.ts';

/** Registers the feature routes. */
export function registerShipmentModule(router: IRouterApi, services?: IServiceRegistry): void {
  registerTrackingRoutes(router, services);
  registerShipmentRoutes(router, services);
}
`);
    syntax(result);
  });
});

describe('module declaration identity', () => {
  for (const mode of ['functional', 'class-based'] as const) {
    it(`admits a ${mode} declaration even without top-level controller or service files`, async () => {
      const fs = createFakeFs({
        [mode === 'functional'
          ? '/app/src/modules/shipment/index.ts'
          : '/app/src/modules/shipment/shipment.module.ts']:
          mode === 'functional'
            ? 'export function registerShipmentModule() {}'
            : 'export class ShipmentModule {}',
        '/app/src/modules/shipment/controllers/tracking.controller.ts':
          mode === 'functional'
            ? 'export function registerTrackingRoutes() {}'
            : 'export class TrackingController {}',
        '/app/src/modules/shipment/services/shipment.service.ts': '',
      });
      expect(await scanModules(fs, '/app', mode)).toEqual({
        names: ['shipment'],
        skipped: [],
        rejected: [],
      });
      const scan = await scanModuleArtifacts(fs, '/app', 'shipment', mode);
      expect(scan.artifacts.controller).toEqual(['controllers/tracking']);
    });

    it(`refuses generation beside a nested controller in a ${mode} module`, async () => {
      for (const name of ['tracking', 'orders']) {
        const pascal = deriveNames(name).pascal;
        const base = createFakeFs({
          '/app/package.json': JSON.stringify({
            dependencies: mode === 'class-based' ? { '@setu-ts/decorator-plugin': '^0.10.0' } : {},
          }),
          [mode === 'functional'
            ? '/app/src/modules/shipment/index.ts'
            : '/app/src/modules/shipment/shipment.module.ts']:
            mode === 'functional'
              ? 'export function registerShipmentModule() {}'
              : 'export class ShipmentModule {}',
          [`/app/src/modules/shipment/controllers/${name}.controller.ts`]:
            mode === 'functional'
              ? `export function register${pascal}Routes() {}`
              : `export class ${pascal}Controller {}`,
        });
        const errors: string[] = [];
        expect(
          await runCli(['g', 'controller', name, '--module', 'shipment'], {
            fs: base,
            cwd: '/app',
            now: () => 0,
            log: () => {},
            error: (line) => errors.push(line),
          }),
        ).toBe(1);
        expect(errors.join('\n')).toContain(`the controller at controllers/${name}`);
        expect(base.writes).toEqual([]);
      }
    });
  }
});

describe('directory link handling', () => {
  it('reports a self-link even when stat fails before identifying a directory', async () => {
    const base = createFakeFs({
      '/app/src/controllers/self/ignored.controller.ts': '',
      '/app/src/controllers/orders.controller.ts': 'export function registerOrdersRoutes() {}',
    });
    const fs: IFileSystem = {
      ...base,
      stat: (path) =>
        path.endsWith('/self') ? Promise.reject(new Error('ELOOP')) : base.stat(path),
      realPath: (path) =>
        path.endsWith('/self') ? Promise.reject(new Error('ELOOP')) : base.realPath!(path),
    };
    const scan = await readArtifactNames(fs, '/app', CONTROLLERS);
    expect(scan.names).toEqual(['orders']);
    expect(scan.unreadable).toEqual([{ path: 'src/controllers/self', reason: 'unsafe-directory' }]);
  });

  for (const root of ['src/controllers', 'src/modules/shipment']) {
    for (const target of ['/outside', '/app/src/elsewhere', `/app/${root}`]) {
      it(`skips and reports a link from ${root}/linked to ${target}, never listing it`, async () => {
        const base = createFakeFs({
          [`/app/${root}/linked/orders.controller.ts`]: 'export function registerOrdersRoutes() {}',
          [`/app/${root}/tracking.controller.ts`]: 'export function registerTrackingRoutes() {}',
        });
        const listed: string[] = [];
        const fs: IFileSystem = {
          ...base,
          realPath: (path) =>
            path === `/app/${root}/linked` ? Promise.resolve(target) : base.realPath!(path),
          readdir: (path) => {
            listed.push(path);
            return base.readdir(path);
          },
        };
        const scan = await readArtifactNames(fs, '/app', { ...CONTROLLERS, dir: root });
        expect(scan.names).toEqual(['tracking']);
        expect(scan.unreadable).toEqual([{ path: `${root}/linked`, reason: 'unsafe-directory' }]);
        expect(listed).not.toContain(`/app/${root}/linked`);
      });
    }
  }

  it('refuses an unresolvable family root and a filesystem without link resolution', async () => {
    const fs = createFakeFs({ '/app/src/controllers/orders.controller.ts': '' });
    for (const realPath of [undefined, () => Promise.reject(new Error('EACCES'))]) {
      const { realPath: omitted, ...base } = fs;
      void omitted;
      const scan = await walkArtifactFiles(
        { ...base, ...(realPath === undefined ? {} : { realPath }) },
        '/app',
        'src/controllers',
      );
      expect(scan).toEqual({
        files: [],
        unreadable: [{ path: 'src/controllers', reason: 'unsafe-directory' }],
      });
    }
  });

  it('reports linked module directories and the modules root without reading their declarations', async () => {
    const base = createFakeFs({
      '/app/src/modules/shipment/shipment.module.ts': 'export class ShipmentModule {}',
    });
    for (const link of ['src/modules', 'src/modules/shipment']) {
      const reads: string[] = [];
      const fs: IFileSystem = {
        ...base,
        realPath: (path) =>
          path === `/app/${link}` ? Promise.resolve('/outside') : base.realPath!(path),
        readFile: (path) => {
          reads.push(path);
          return base.readFile(path);
        },
      };
      expect(await scanModules(fs, '/app')).toEqual({
        names: [],
        skipped: [],
        rejected: [],
        unreadable: [{ path: link, reason: 'unsafe-directory' }],
      });
      expect(reads).toEqual([]);
    }
  });

  it('reports skipped directories through diagnosis and generate guidance', async () => {
    for (const name of ['orders', 'invoices']) {
      const base = createFakeFs({ [`/app/src/controllers/${name}/nested.controller.ts`]: '' });
      const fs: IFileSystem = {
        ...base,
        realPath: (path) =>
          path === `/app/src/controllers/${name}`
            ? Promise.resolve('/outside')
            : base.realPath!(path),
      };
      const result = await diagnoseProject(fs, '/app', new Set());
      const lines: string[] = [];
      renderGenerateFindings(result, (line) => lines.push(line));
      expect(lines).toContain(
        `Skipped directory src/controllers/${name}: its path cannot be verified without following a link inside the project.`,
      );
      expect(base.writes).toEqual([]);
    }
  });

  for (const folder of ['linked', 'linked.ts']) {
    it(`holds the complete barrel when ${folder} is skipped, even if its name ends in .ts`, async () => {
      const barrel = `// User's existing registration must survive an incomplete scan.
import { registerOrdersRoutes } from './${folder}/orders.controller.ts';
export const registerGeneratedRoutes = registerOrdersRoutes;
`;
      const base = createFakeFs({
        '/app/package.json': '{}',
        '/app/setu.config.ts': 'registerGeneratedRoutes;',
        '/app/src/controllers/index.ts': barrel,
        [`/app/src/controllers/${folder}/orders.controller.ts`]:
          'export function registerOrdersRoutes() {}',
      });
      const fs: IFileSystem = {
        ...base,
        realPath: (path) =>
          path === `/app/src/controllers/${folder}`
            ? Promise.resolve('/outside')
            : base.realPath!(path),
      };
      const errors: string[] = [];
      expect(
        await runCli(['sync'], {
          fs,
          cwd: '/app',
          now: () => 0,
          log: () => {},
          error: (line) => errors.push(line),
        }),
      ).toBe(1);
      expect(errors.join('\n')).toContain(`Skipped directory src/controllers/${folder}`);
      expect(base.read('/app/src/controllers/index.ts')).toBe(barrel);
      syntax(base.read('/app/src/controllers/index.ts'));
      expect(base.writes).toEqual([]);
    });
  }

  for (const module of ['shipment', 'billing']) {
    it(`preserves the complete activation barrel when ${module} is a linked module directory`, async () => {
      const barrel = `export const registerModules = () => {};
// Existing activation of ${module} must survive the refused directory.
`;
      const base = createFakeFs({
        '/app/package.json': '{}',
        '/app/setu.config.ts': 'registerModules;',
        '/app/src/modules/index.ts': barrel,
        [`/app/src/modules/${module}/index.ts`]: `export function register${deriveNames(module).pascal}Module() {}`,
      });
      const fs: IFileSystem = {
        ...base,
        realPath: (path) =>
          path === `/app/src/modules/${module}`
            ? Promise.resolve('/outside')
            : base.realPath!(path),
      };
      expect(
        await runCli(['sync'], {
          fs,
          cwd: '/app',
          now: () => 0,
          log: () => {},
          error: () => {},
        }),
      ).toBe(1);
      expect(base.read('/app/src/modules/index.ts')).toBe(barrel);
      syntax(base.read('/app/src/modules/index.ts'));
      expect(base.writes).toEqual([]);
    });
  }
});

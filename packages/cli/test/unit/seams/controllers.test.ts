import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  FUNCTION_CONTROLLER_ARTIFACTS,
} from '../../../src/seams/http.ts';
import { scanSeamSpecs } from '../../../src/seams/registry.ts';
import { readArtifactNames, scanArtifacts } from '../../../src/utils/artifact-scanner.ts';
import { generateController } from '../../../src/schematics/controller.ts';
import { generateRoute } from '../../../src/schematics/route.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

function syntax(source: string): void {
  expect(
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }).diagnostics,
  ).toEqual([]);
}

describe('one controller family with two shapes', () => {
  it('has one suffix and one registry entry in both project styles', () => {
    for (const installed of [new Set<string>(), new Set(['decorator-plugin'])]) {
      const specs = scanSeamSpecs(installed);
      expect(specs.filter((spec) => spec.dir === 'src/controllers')).toHaveLength(1);
      expect(specs.find((spec) => spec.schematic === 'controller')?.suffix).toBe('.controller.ts');
      expect(specs.some((spec) => spec.schematic === 'route' || spec.suffix === '.routes.ts')).toBe(
        false,
      );
    }
  });

  it('admits class controllers and function controllers by their exports in class-based projects', async () => {
    const fs = createFakeFs({
      '/app/src/controllers/orders.controller.ts': 'export class OrdersController {}',
      '/app/src/controllers/nested/proxy.controller.ts': 'export function registerProxyRoutes() {}',
      '/app/src/controllers/old.routes.ts': 'export function registerOldRoutes() {}',
      '/app/src/controllers/bad.controller.ts': 'export const unrelated = 1;',
    });
    const scan = await scanArtifacts(fs, '/app', [CONTROLLERS_SEAM]);
    expect(scan.artifacts).toEqual({
      controller: ['nested/proxy', 'orders'],
      'controller-functions': ['nested/proxy'],
    });
    expect(scan.skipped).toEqual([
      {
        path: 'src/controllers/bad.controller.ts',
        missing: ['BadController or registerBadRoutes'],
      },
    ]);
    const barrel = CONTROLLERS_SEAM.renderBarrel(scan.artifacts);
    expect(barrel).toContain("import { registerProxyRoutes } from './nested/proxy.controller.ts'");
    expect(barrel).toContain('APP_CONTROLLERS: readonly Constructor[] = [OrdersController]');
    expect(barrel).not.toContain('ProxyController');
    expect(barrel).not.toContain('Old');
    syntax(barrel);
  });

  it('admits only function controllers in functional projects', async () => {
    const scan = await readArtifactNames(
      createFakeFs({
        '/app/src/controllers/orders.controller.ts': 'export class OrdersController {}',
        '/app/src/controllers/proxy.controller.ts': 'export function registerProxyRoutes() {}',
      }),
      '/app',
      FUNCTIONAL_CONTROLLERS_SEAM,
    );
    expect(scan.names).toEqual(['proxy']);
    expect(scan.skipped).toEqual([
      { path: 'src/controllers/orders.controller.ts', missing: ['registerOrdersRoutes'] },
    ]);
  });

  it('checks duplicate base names across class and function shapes', async () => {
    await expect(
      scanArtifacts(
        createFakeFs({
          '/app/src/controllers/a/orders.controller.ts': 'export class OrdersController {}',
          '/app/src/controllers/b/orders.controller.ts':
            'export function registerOrdersRoutes() {}',
        }),
        '/app',
        [CONTROLLERS_SEAM],
      ),
    ).rejects.toMatchObject({ name: 'DuplicateArtifactNameError' });
  });

  it('keeps a hand-registered function controller out of the barrel and its shape metadata', async () => {
    const scan = await scanArtifacts(
      createFakeFs({
        '/app/setu.config.ts': 'registerProxyRoutes(app.router, app.services);',
        '/app/src/controllers/proxy.controller.ts': 'export function registerProxyRoutes() {}',
      }),
      '/app',
      [CONTROLLERS_SEAM],
    );
    expect(scan.artifacts).toEqual({ controller: [] });
    expect(scan.manual).toEqual([
      {
        path: 'src/controllers/proxy.controller.ts',
        symbol: 'registerProxyRoutes',
        wiredIn: 'setu.config.ts',
      },
    ]);
  });

  for (const name of ['orders', 'invoices']) {
    it(`makes functional g route ${name} identical to g controller ${name}`, () => {
      const options = { runtime: 'node' as const, now: () => 0, plugins: new Set<string>() };
      expect(generateRoute(deriveNames(name), options)).toEqual(
        generateController(deriveNames(name), options),
      );
    });

    for (const style of ['functional', 'class-based'] as const) {
      it(`g route ${name} writes a function controller in ${style} style`, async () => {
        const fs = createFakeFs({
          '/app/package.json': JSON.stringify({
            dependencies: style === 'class-based' ? { '@setu-ts/decorator-plugin': '^0.10.0' } : {},
          }),
        });
        const errors: string[] = [];
        const run = (args: readonly string[]) =>
          runCli(args, {
            fs,
            cwd: '/app',
            now: () => 0,
            log: () => {},
            error: (line) => errors.push(line),
          });
        expect(await run(['g', 'route', name]), errors.join('\n')).toBe(0);
        const source = fs.read(`/app/src/controllers/${name}.controller.ts`);
        expect(source).toContain(`export function register${deriveNames(name).pascal}Routes(`);
        expect(source).not.toContain('@Controller(');
        expect(fs.has(`/app/src/controllers/${name}.routes.ts`)).toBe(false);
        // Subsequent generation re-reads the shape from exports rather than the
        // command that originally created the file.
        expect(await run(['g', 'controller', 'tracking']), errors.join('\n')).toBe(0);
        const barrel = fs.read('/app/src/controllers/index.ts');
        const list = /const GENERATED_ROUTE_REGISTRARS:[^=]+= \[([\s\S]*?)\];/.exec(barrel)?.[1];
        expect(
          list
            ?.split(',')
            .map((value) => value.trim())
            .filter(Boolean)
            .sort(),
        ).toEqual(
          (style === 'class-based'
            ? [`register${deriveNames(name).pascal}Routes`]
            : [`register${deriveNames(name).pascal}Routes`, 'registerTrackingRoutes']
          ).sort(),
        );
        expect(barrel).not.toContain(`${deriveNames(name).pascal}Controller`);
        if (style === 'class-based') expect(barrel).toContain('[TrackingController]');
        syntax(source);
        syntax(barrel);
      });
    }

    it(`names both accepted export shapes when ${name} cannot be admitted`, async () => {
      const scan = await readArtifactNames(
        createFakeFs({
          [`/app/src/controllers/${name}.controller.ts`]: 'export const unrelated = 1;',
        }),
        '/app',
        CONTROLLERS_SEAM,
      );
      const pascal = deriveNames(name).pascal;
      expect(scan.skipped).toEqual([
        {
          path: `src/controllers/${name}.controller.ts`,
          missing: [`${pascal}Controller or register${pascal}Routes`],
        },
      ]);
    });
  }

  it('pins the complete mixed-shape barrel, with each controller registered through its own path', () => {
    const source = CONTROLLERS_SEAM.renderBarrel({
      controller: ['nested/proxy', 'orders'],
      [FUNCTION_CONTROLLER_ARTIFACTS]: ['nested/proxy'],
    });
    expect(source).toBe(`// Generated by \`setu generate controller\`.
// The CLI owns this file and rewrites it whenever an artifact is added, so edits
// here are lost — add them with the CLI.
//
// \`setu.config.ts\` consumes it as:
//
//   DecoratorPlugin({ controllers: [...APP_CONTROLLERS] })
//   a starter's \`decorators: { controllers: [...APP_CONTROLLERS] }\` arm
//   registerGeneratedRoutes(app.router, app.services);
//
// If you scaffolded this project before this seam existed, add those lines to
// wire generated artifacts in.

import type { Constructor, IRouterApi, IServiceRegistry } from '@setu-ts/common';

import { OrdersController } from './orders.controller.ts';

import { registerProxyRoutes } from './nested/proxy.controller.ts';

/** A generated registrar may predate the service-registry parameter. */
type GeneratedRouteRegistrar = (router: IRouterApi, services?: IServiceRegistry) => void;

const GENERATED_ROUTE_REGISTRARS: readonly GeneratedRouteRegistrar[] = [
  registerProxyRoutes,
];

/** Every generated controller class, for \`DecoratorPlugin({ controllers })\`. */
export const APP_CONTROLLERS: readonly Constructor[] = [OrdersController];

/**
 * Registers every generated function controller.
 *
 * @param router - The router to register on, normally \`app.router\`
 * @param services - The service registry, normally \`app.services\`. Optional so a
 *   setu.config.ts written before this parameter existed still compiles.
 */
export function registerGeneratedRoutes(
  router: IRouterApi,
  services?: IServiceRegistry,
): void {
  for (const register of GENERATED_ROUTE_REGISTRARS) {
    register(router, services);
  }
}
`);
    syntax(source);
  });
});

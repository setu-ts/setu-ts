/**
 * Source-built scaffolds keep class controllers and function controllers wired,
 * flat and then modular: the first module adopts the flat files, a module
 * controller moved into a subfolder is relocated by `setu sync`, and every route
 * answers over HTTP. @module
 */
import * as nodeFs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { tempDir } from '../../../../test/node-helpers.ts';
import { REPO_ROOT } from '../fixtures/generated-project.ts';
import {
  npmInstall,
  npmRun,
  runIn,
  startOverlay,
  withNodeServer,
} from '../fixtures/node-project.ts';

let root = '';
beforeEach(async () => {
  root = await tempDir({ prefix: 'controllers-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true, force: true });
});

const SOURCE_CLI: readonly string[] = [
  '--import',
  `${REPO_ROOT}/scripts/lib/source-register.ts`,
  `${REPO_ROOT}/packages/cli/src/bin.ts`,
];

const FUNCTION_CONTROLLER: string = `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
export function registerProxyRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  for (const path of ['/proxy/*', '/mirror/*']) {
    router.get(path, (ctx) => ctx.response.json({ ok: true }));
  }
}
`;

for (const style of ['functional', 'class-based'] as const) {
  it(
    `keeps both controller shapes wired from flat to modular in ${style} style`,
    { timeout: 900_000 },
    async () => {
      const scaffold = await runIn(root, 'node', [
        ...SOURCE_CLI,
        'new',
        'shop',
        '--template',
        'rest',
        '--runtime',
        'node',
        ...(style === 'class-based' ? ['--style', 'class-based'] : []),
      ]);
      expect(scaffold.code, scaffold.output).toBe(0);
      const project = `${root}/shop`;
      const overlay = await startOverlay();
      try {
        const installed = await npmInstall(project, overlay);
        expect(installed.code, installed.output).toBe(0);
        for (const args of [
          ['g', 'controller', 'orders'],
          ['g', 'route', 'proxy'],
        ]) {
          const generated = await runIn(project, 'node', [...SOURCE_CLI, ...args]);
          expect(generated.code, generated.output).toBe(0);
        }
        expect(
          await nodeFs.readFile(`${project}/src/controllers/proxy.controller.ts`, 'utf8'),
        ).toContain('export function registerProxyRoutes(');
        await expect(nodeFs.stat(`${project}/src/controllers/proxy.routes.ts`)).rejects.toThrow();
        await nodeFs.writeFile(
          `${project}/src/controllers/proxy.controller.ts`,
          FUNCTION_CONTROLLER,
        );
        const generated = await runIn(project, 'node', [
          ...SOURCE_CLI,
          'g',
          'controller',
          'tracking',
        ]);
        expect(generated.code, generated.output).toBe(0);
        await nodeFs.mkdir(`${project}/src/controllers/nested`);
        await nodeFs.rename(
          `${project}/src/controllers/proxy.controller.ts`,
          `${project}/src/controllers/nested/proxy.controller.ts`,
        );
        for (const command of ['sync', 'check']) {
          const result = await runIn(project, 'node', [...SOURCE_CLI, command]);
          expect(result.code, result.output).toBe(0);
        }
        const barrel = await nodeFs.readFile(`${project}/src/controllers/index.ts`, 'utf8');
        expect(barrel).toContain("from './nested/proxy.controller.ts'");
        expect(barrel).not.toContain('ProxyController');

        // The first module refuses while the flat homes hold files, then adopts them.
        const cli = (...args: string[]) => runIn(project, 'node', [...SOURCE_CLI, ...args]);
        const refused = await cli('g', 'module', 'shipment');
        expect(refused.code, refused.output).toBe(1);
        expect(refused.output).toContain('src/controllers/nested/proxy.controller.ts');
        const adopted = await cli('g', 'module', 'shipment', '--adopt-controllers');
        expect(adopted.code, adopted.output).toBe(0);
        await expect(nodeFs.stat(`${project}/src/controllers`)).rejects.toThrow();
        const config = await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8');
        expect(config).toContain('registerModules(app.router, app.services);');
        expect(config).not.toContain('registerGeneratedRoutes');
        const flat = await cli('g', 'controller', 'loose');
        expect(flat.code, flat.output).toBe(2);
        const scoped = await cli('g', 'controller', 'parcels', '--module', 'shipment');
        expect(scoped.code, scoped.output).toBe(0);
        await nodeFs.mkdir(`${project}/src/modules/shipment/controllers`);
        await nodeFs.rename(
          `${project}/src/modules/shipment/parcels.controller.ts`,
          `${project}/src/modules/shipment/controllers/parcels.controller.ts`,
        );
        for (const args of [['sync'], ['check'], ['add', 'view', '--module', 'shipment']]) {
          const result = await cli(...args);
          expect(result.code, `${args.join(' ')}\n${result.output}`).toBe(0);
        }
        const reinstalled = await npmInstall(project, overlay);
        expect(reinstalled.code, reinstalled.output).toBe(0);
        const checked = await cli('check');
        expect(checked.code, checked.output).toBe(0);

        const typed = await runIn(project, `${project}/node_modules/.bin/tsc`, ['--noEmit']);
        expect(typed.code, typed.output).toBe(0);
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);
        await withNodeServer(project, async (origin) => {
          for (const path of [
            '/greetings',
            '/orders',
            '/tracking',
            '/proxy/check',
            '/mirror/check',
            '/shipment',
            '/shipment/parcels',
            '/ui',
          ]) {
            const response = await fetch(`${origin}${path}`);
            await response.body?.cancel();
            expect(response.status, `${style} ${path}`).toBe(200);
          }
        });
      } finally {
        await overlay.close();
      }
    },
  );
}

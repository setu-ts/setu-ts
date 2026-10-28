import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import {
  npmInstall,
  npmRun,
  runIn,
  startOverlay,
  withNodeServer,
  type RegistryOverlay,
} from '../fixtures/node-project.ts';

const runtime = createNodeRuntimeServices();
let overlay: RegistryOverlay;
let root: string;
beforeAll(async () => {
  overlay = await startOverlay();
}, 900_000);
afterAll(async () => {
  await overlay?.close();
});
beforeEach(async () => {
  await fs.mkdir('.tmp', { recursive: true });
  root = resolve(await fs.mkdtemp('.tmp/m120-build-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function cli(args: readonly string[]): Promise<void> {
  const errors: string[] = [];
  expect(
    await runCli(args, {
      fs: runtime.fs!,
      cwd: root,
      now: () => 0,
      log: () => {},
      error: (line) => errors.push(line),
    }),
    errors.join('\n'),
  ).toBe(0);
}

for (const template of ['rest', 'class-based', 'full-stack']) {
  it(`builds and serves the compiled ${template} scaffold`, { timeout: 600_000 }, async () => {
    await cli(['new', 'app', '--template', template]);
    const project = `${root}/app`;
    const installed = await npmInstall(project, overlay);
    expect(installed.code, installed.output).toBe(0);
    const built = await npmRun(project, 'build');
    expect(built.code, built.output).toBe(0);
    await fs.stat(`${project}/dist/main.js`);
    await fs.stat(`${project}/dist/main.js.map`);
    await withNodeServer(project, async (origin) => {
      const health = await fetch(`${origin}/health`);
      expect(health.status).toBe(200);
      const response = await fetch(`${origin}/`);
      expect(response.status).toBe(200);
      const page = await response.text();
      if (template === 'full-stack') {
        expect(page).toContain('data-shell="frame"');
        // The browser loads the client bundle the page names; the compiled
        // server must serve it (M120 review: the serverBuild arm once set no
        // assetsDir, and every /assets/*.js was a 404).
        const asset = /\/assets\/[^"]+\.js/.exec(page)?.[0];
        expect(asset, page).toBeDefined();
        const script = await fetch(`${origin}${asset}`);
        expect(script.status).toBe(200);
        expect(script.headers.get('content-type')).toMatch(/javascript/);
      }
    });
  });
}

it(
  'inlines workspace libraries, externalizes their dependencies, and serves their value',
  { timeout: 600_000 },
  async () => {
    await cli(['new', 'acme', '--workspace']);
    const workspace = `${root}/acme`;
    await cli(['generate', 'app', 'api', '--template', 'rest', '--dir', workspace]);
    await cli(['generate', 'library', 'shared', '--scope', 'acme', '--dir', workspace]);
    const library = `${workspace}/libs/shared`;
    const manifest = JSON.parse(await fs.readFile(`${library}/package.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['dependencies'] = { 'escape-html': '^1.0.3' };
    await fs.writeFile(`${library}/package.json`, JSON.stringify(manifest));
    await fs.writeFile(
      `${library}/src/index.ts`,
      '/// <reference path="./escape.d.ts" />\nimport escape from \'escape-html\';\nexport function shared(value: string): string { return escape(value); }\n',
    );
    await fs.writeFile(
      `${library}/src/escape.d.ts`,
      "declare module 'escape-html' { export default function escape(value: string): string; }\n",
    );
    const project = `${workspace}/apps/api`;
    const main = await fs.readFile(`${project}/main.ts`, 'utf8');
    await fs.writeFile(
      `${project}/main.ts`,
      `import { shared } from '@acme/shared';\n` +
        main.replace(
          'await app.start(',
          "app.router.get('/library', (ctx) => ctx.response.json({ value: shared('<m120>') }));\nawait app.start(",
        ),
    );
    const installed = await npmInstall(workspace, overlay);
    expect(installed.code, installed.output).toBe(0);
    const built = await npmRun(project, 'build');
    expect(built.code, built.output).toBe(0);
    const bundle = await fs.readFile(`${project}/dist/main.js`, 'utf8');
    expect(bundle).not.toContain(`from '@acme/shared'`);
    expect(bundle).toContain('escape-html');
    // A member normally binds its discovery port. Let this fixture's PORT choose
    // a free socket without rewriting the service being measured.
    const discovery = `${project}/src/discovery/services.ts`;
    const source = await fs.readFile(discovery, 'utf8');
    await fs.writeFile(
      discovery,
      source.replace(
        /export const SERVICE_PORT[^;]+;/,
        "export const SERVICE_PORT = Number(process.env.PORT ?? '3000');",
      ),
    );
    const rebuilt = await npmRun(project, 'build');
    expect(rebuilt.code, rebuilt.output).toBe(0);
    await withNodeServer(project, async (origin) => {
      expect(await (await fetch(`${origin}/library`)).json()).toEqual({ value: '&lt;m120&gt;' });
    });
  },
);

it(
  'rejects wiring drift and type errors before writing dist, and emits the migration entry',
  { timeout: 600_000 },
  async () => {
    await cli(['new', 'app', '--template', 'rest']);
    const project = `${root}/app`;
    const installed = await npmInstall(project, overlay);
    expect(installed.code, installed.output).toBe(0);
    await cli(['generate', 'controller', 'original', '--dir', project]);
    const original = await fs.readFile(`${project}/src/controllers/original.controller.ts`, 'utf8');
    await fs.writeFile(
      `${project}/src/controllers/extra.controller.ts`,
      original.replaceAll('Original', 'Extra').replaceAll('original', 'extra'),
    );
    const drift = await npmRun(project, 'build');
    expect(drift.code).not.toBe(0);
    expect(drift.output).toContain('setu.E003');
    expect(drift.output).toContain('extra.controller.ts');
    await expect(fs.stat(`${project}/dist`)).rejects.toThrow();
    await fs.rm(`${project}/src/controllers/extra.controller.ts`);
    await fs.writeFile(`${project}/src/type-error.ts`, 'export const value: string = 123;\n');
    const typeError = await npmRun(project, 'build');
    expect(typeError.code).not.toBe(0);
    expect(typeError.output).toContain('type-error.ts');
    await expect(fs.stat(`${project}/dist`)).rejects.toThrow();
    await fs.rm(`${project}/src/type-error.ts`);
    await cli(['add', 'database', '--dir', project]);
    const databaseInstalled = await npmInstall(project, overlay);
    expect(databaseInstalled.code, databaseInstalled.output).toBe(0);
    await cli(['generate', 'migration', 'initial', '--dir', project]);
    const built = await npmRun(project, 'build');
    expect(built.code, built.output).toBe(0);
    await fs.stat(`${project}/dist/src/migrations/run.js`);
    const runner = await runIn(project, 'node', [
      '--input-type=module',
      '-e',
      "import { runMigrations } from './dist/src/migrations/run.js'; await runMigrations('down', { database: {}, ledger: { applied: async () => [] } }); console.log('compiled migration no-op');",
    ]);
    expect(runner.code, runner.output).toBe(0);
    expect(runner.output).toContain('compiled migration no-op');
  },
);

it.skipIf(spawnSync('bun', ['--version']).status !== 0)(
  'Bun members resolve generated libraries after a plain install',
  { timeout: 600_000 },
  async () => {
    await cli(['new', 'acme', '--workspace', '--runtime', 'bun']);
    const workspace = `${root}/acme`;
    await cli(['generate', 'app', 'api', '--template', 'rest', '--dir', workspace]);
    await cli(['generate', 'library', 'shared', '--dir', workspace]);
    const installed = await runIn(workspace, 'bun', ['install'], overlay);
    expect(installed.code, installed.output).toBe(0);
    await fs.writeFile(
      `${workspace}/apps/api/probe.ts`,
      `import { shared } from '@acme/shared'; console.log(shared('m120'));\n`,
    );
    const ran = await runIn(`${workspace}/apps/api`, 'bun', ['run', 'probe.ts']);
    expect(ran.code, ran.output).toBe(0);
    expect(ran.output).toContain('shared: m120');
    await fs.rm(`${workspace}/node_modules`, { recursive: true, force: true });
    const production = await runIn(workspace, 'bun', ['install', '--production'], overlay);
    expect(production.code, production.output).toBe(0);
    const productionImport = await runIn(`${workspace}/apps/api`, 'bun', ['run', 'probe.ts']);
    expect(productionImport.code, productionImport.output).toBe(0);
    expect(productionImport.output).toContain('shared: m120');
  },
);

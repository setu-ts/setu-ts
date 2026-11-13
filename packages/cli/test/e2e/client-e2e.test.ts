import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
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
  root = resolve(await fs.mkdtemp('.tmp/m129-client-e2e-'));
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

async function script(project: string, name: string): Promise<void> {
  const result = await npmRun(project, name);
  expect(result.code, result.output).toBe(0);
}

it(
  'generates, validates and calls a REST client, detects drift and matches a served document',
  { timeout: 600_000 },
  async () => {
    await cli(['new', 'api', '--template', 'rest']);
    const project = `${root}/api`;
    await cli(['add', 'sdk', '--dir', project]);
    const installed = await npmInstall(project, overlay);
    expect(installed.code, installed.output).toBe(0);
    await script(project, 'client');
    for (const name of ['check', 'lint', 'format:check', 'client:check'])
      await script(project, name);

    // An explicit operation id lets this exercise call the same generated method after a route edit.
    const configPath = `${project}/setu.config.ts`;
    const config = await fs.readFile(configPath, 'utf8');
    expect(config).toContain('return app;');
    await fs.writeFile(
      configPath,
      config.replace(
        'return app;',
        "app.router.get('/m129', { handler: (ctx) => ctx.response.json({ message: 'm129' }), schema: { operationId: 'm129Probe', deprecated: true } });\n  app.router.get('/m137a-hidden', { handler: (ctx) => ctx.response.json({ hidden: true }), schema: { operationId: 'm137aHidden', excludeFromDocument: true } });\n  return app;",
      ),
    );
    const drift = await npmRun(project, 'client:check');
    expect(drift.code, drift.output).toBe(1);
    expect(drift.output).toContain('is out of date');
    await script(project, 'client');
    const generated = await fs.readFile(`${project}/src/clientsdk/api.ts`, 'utf8');
    expect(generated).toMatch(/\/\*\* @deprecated \*\/\s+m129Probe\(/);
    expect(generated).toMatch(
      /\/\*\*\s+\* m129Probe\s+\* Deprecated operation\.\s+\*\/\s+function m129Probe\(/,
    );
    expect(generated.match(/@deprecated/g)).toHaveLength(1);
    expect(generated).not.toContain('m137aHidden');
    await script(project, 'client:check');
    await script(project, 'format');
    for (const name of ['check', 'lint', 'format:check', 'build']) await script(project, name);
    await withNodeServer(project, async (origin) => {
      const response = await fetch(`${origin}/openapi.json`);
      expect(response.status).toBe(200);
      const document = await response.text();
      await fs.writeFile(`${project}/openapi.json`, document);
      const before = await fs.readFile(`${project}/src/clientsdk/api.ts`, 'utf8');
      const saved = await runIn(project, 'setu', ['client', '--input', 'openapi.json']);
      expect(saved.code, saved.output).toBe(0);
      expect(await fs.readFile(`${project}/src/clientsdk/api.ts`, 'utf8')).toBe(before);
      const call = await runIn(project, 'tsx', [
        '--eval',
        `import { createClient } from '@setu-ts/sdk'; import { createApi } from './src/clientsdk/api.ts'; createApi(createClient({ baseUrl: '${origin}' })).m129Probe().then((res) => { if (res.status !== 200 || res.data.message !== 'm129') throw new Error('wrong generated response'); console.log('m129 generated call passed'); });`,
      ]);
      expect(call.code, call.output).toBe(0);
      expect(call.output).toContain('m129 generated call passed');
    });
  },
);

it(
  'refuses minimal without OpenApiPlugin and succeeds after setu add openapi',
  { timeout: 600_000 },
  async () => {
    await cli(['new', 'minimal']);
    const project = `${root}/minimal`;
    await cli(['add', 'sdk', '--dir', project]);
    const installed = await npmInstall(project, overlay);
    expect(installed.code, installed.output).toBe(0);
    const refused = await npmRun(project, 'client');
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('openapi-plugin is not registered');
    await cli(['add', 'openapi', '--dir', project]);
    const added = await npmInstall(project, overlay);
    expect(added.code, added.output).toBe(0);
    await script(project, 'client');
    await script(project, 'client:check');
    expect(await fs.readFile(`${project}/src/clientsdk/api.ts`, 'utf8')).toContain(
      'export function createApi',
    );
  },
);

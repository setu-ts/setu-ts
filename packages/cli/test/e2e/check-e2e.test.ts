/** The gate and repair commands over real scaffolded project files. @module */
import * as nodeFs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { detectPlugins } from '../../src/utils/plugin-detector.ts';
import { scanSeamSpecs } from '../../src/seams/registry.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { createRecorder } from '../fixtures/fake-fs.ts';

const runtime = createNodeRuntimeServices();
let root = '';
beforeEach(async () => {
  root = await tempDir({ prefix: 'setu-check-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true, force: true });
});

async function run(args: readonly string[]) {
  const err = createRecorder();
  const log = createRecorder();
  const code = await runCli(args, {
    fs: runtime.fs!,
    cwd: root,
    now: () => runtime.now(),
    error: err.sink,
    log: log.sink,
  });
  return { code, err: err.text(), log: log.text() };
}

for (const template of ['rest', 'class-based', 'microservice']) {
  it(`checks and repairs every registration family present in a ${template} scaffold`, async () => {
    expect((await run(['new', 'shop', '--template', template])).code).toBe(0);
    const project = `${root}/shop`;
    const check = () => run(['check', '--dir', project]);
    const sync = () => run(['sync', '--dir', project]);
    expect(await check()).toMatchObject({ code: 0, err: '' });
    const installed = await detectPlugins(runtime.fs!, project);
    const config = await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8');
    let exercised = 0;
    for (const spec of scanSeamSpecs(installed)) {
      if (
        spec.exports.length === 0 ||
        (spec.requiresPlugin !== undefined && !installed.has(spec.requiresPlugin))
      )
        continue;
      // Only families this host actually wires are in this e2e's scope.
      if (!spec.exports.every((symbol) => config.includes(symbol))) continue;
      exercised++;
      const name = `probe-${spec.schematic}`;
      const path = `${spec.dir}/${name}${spec.suffix}`;
      const symbols = spec.importSymbols(deriveNames(name));
      const source = symbols.map((symbol) => `export const ${symbol} = {};`).join('\n');
      await nodeFs.mkdir(`${project}/${spec.dir}`, { recursive: true });
      await nodeFs.writeFile(`${project}/${path}`, source);
      const drift = await check();
      expect(drift.code, drift.err).toBe(1);
      expect(drift.err).toContain(path);
      expect((await sync()).code).toBe(0);
      expect((await check()).code).toBe(0);
      const canonical = await nodeFs.readFile(`${project}/${spec.barrel}`, 'utf8');

      const removed = canonical.replace(
        new RegExp(
          `(?:import|export)\\s+(?:type\\s+)?\\{[^}]*\\}\\s+from\\s*['"]\\./${name}${spec.suffix.replaceAll('.', '\\.')}['"];?`,
          'g',
        ),
        '',
      );
      expect(removed).not.toBe(canonical);
      await nodeFs.writeFile(`${project}/${spec.barrel}`, removed);
      const missingImport = await check();
      expect(missingImport.code, missingImport.err).toBe(1);
      expect(missingImport.err).toContain(path);
      expect((await sync()).code).toBe(0);
      expect(await nodeFs.readFile(`${project}/${spec.barrel}`, 'utf8')).toBe(canonical);

      // The real generate path produces the same barrel for the same name set.
      if (spec.schematic !== 'ingress') {
        await nodeFs.rm(`${project}/${path}`);
        const generated = await run(['generate', spec.schematic, name, '--dir', project]);
        expect(generated.code, generated.err).toBe(0);
        expect(await nodeFs.readFile(`${project}/${spec.barrel}`, 'utf8')).toBe(canonical);
      }
      await nodeFs.writeFile(`${project}/setu.config.ts`, `${config}\nvoid ${symbols[0]};\n`);
      const manual = await check();
      expect(manual.code).toBe(1);
      expect(manual.err).toContain('setu.E005');
      expect(manual.err).toContain(path);
      expect((await sync()).code).toBe(1);
      await nodeFs.writeFile(`${project}/setu.config.ts`, config);

      await nodeFs.writeFile(`${project}/${path}`, '');
      const skipped = await check();
      expect(skipped.code).toBe(1);
      expect(skipped.err).toContain('setu.E001');
      expect(skipped.err).toContain(path);
      expect((await sync()).code).toBe(1);
      expect(await nodeFs.readFile(`${project}/${path}`, 'utf8')).toBe('');
      await nodeFs.writeFile(`${project}/${path}`, source);
      expect((await sync()).code).toBe(0);
      expect((await check()).code).toBe(0);

      // Changing quotes and layout never changes the imported artifact sets.
      await nodeFs.writeFile(
        `${project}/${spec.barrel}`,
        canonical.replaceAll("'", '"').replaceAll('import {', 'import {\n'),
      );
      expect((await check()).code).toBe(0);
      await nodeFs.writeFile(`${project}/${spec.barrel}`, canonical);
    }
    expect(exercised).toBeGreaterThanOrEqual(4);

    expect((await run(['generate', 'module', 'orders', '--dir', project])).code).toBe(0);
    const activationPath = `${project}/src/modules/index.ts`;
    const activation = await nodeFs.readFile(activationPath, 'utf8');
    await nodeFs.writeFile(activationPath, '');
    const inactive = await check();
    expect(inactive.code).toBe(1);
    expect(inactive.err).toContain('Module "orders"');
    expect((await sync()).code).toBe(0);
    expect(await nodeFs.readFile(activationPath, 'utf8')).toBe(activation);
    expect((await check()).code).toBe(0);
    const declaration = `${project}/src/modules/orders/${installed.has('decorator-plugin') ? 'orders.module.ts' : 'index.ts'}`;
    const declarationSource = await nodeFs.readFile(declaration, 'utf8');
    await nodeFs.writeFile(declaration, '');
    const missingModuleExport = await check();
    expect(missingModuleExport.code).toBe(1);
    expect(missingModuleExport.err).toContain('setu.E007');
    expect(missingModuleExport.err).toContain('src/modules/orders');
    expect((await sync()).code).toBe(1);
    expect(await nodeFs.readFile(declaration, 'utf8')).toBe('');
    await nodeFs.writeFile(declaration, declarationSource);
    expect((await sync()).code).toBe(0);
    expect((await check()).code).toBe(0);
    await nodeFs.writeFile(
      `${project}/setu.config.ts`,
      `${config}\nconst label = \`unclassifiable\`;`,
    );
    expect((await check()).code).toBe(0);
    expect((await run(['check', '--strict', '--dir', project])).code).toBe(1);
    await nodeFs.mkdir(`${project}/.setu-ts`, { recursive: true });
    await nodeFs.writeFile(
      `${project}/.setu-ts/check.json`,
      JSON.stringify({ silence: ['setu.W001'] }),
    );
    expect((await run(['check', '--strict', '--dir', project])).code).toBe(0);
  });
}

it('checks two workspace members and names the broken member', async () => {
  expect((await run(['new', 'workspace', '--workspace'])).code).toBe(0);
  const workspace = `${root}/workspace`;
  for (const name of ['orders', 'billing'])
    expect(
      (await run(['generate', 'app', name, '--template', 'rest', '--dir', workspace])).code,
    ).toBe(0);
  expect((await run(['check', '--dir', workspace])).code).toBe(0);
  await nodeFs.writeFile(
    `${workspace}/apps/billing/src/controllers/extra.controller.ts`,
    'export function registerExtraRoutes() {}',
  );
  const result = await run(['check', '--dir', workspace]);
  expect(result.code).toBe(1);
  expect(result.err).toContain('billing: error setu.E003:');
  expect((await run(['sync', '--dir', workspace])).code).toBe(0);
  expect((await run(['check', '--dir', workspace])).code).toBe(0);
});

it('refuses a workspace member reached through a symbolic link, writing nothing through it', async () => {
  expect((await run(['new', 'workspace', '--workspace'])).code).toBe(0);
  const workspace = `${root}/workspace`;
  expect(
    (await run(['generate', 'app', 'orders', '--template', 'rest', '--dir', workspace])).code,
  ).toBe(0);
  // The member's real files move outside the workspace; a link takes their place.
  const outside = `${root}/outside`;
  await nodeFs.rename(`${workspace}/apps/orders`, outside);
  await nodeFs.symlink(outside, `${workspace}/apps/orders`);
  const sentinel = `${outside}/src/controllers/index.ts`;
  await nodeFs.writeFile(sentinel, 'sentinel\n');
  for (const command of ['sync', 'check']) {
    const result = await run([command, '--dir', workspace]);
    expect(result.code, command).toBe(1);
    expect(result.err).toContain('orders: ');
    expect(result.err).toContain('is a symlinked member of the workspace');
  }
  expect(await nodeFs.readFile(sentinel, 'utf8')).toBe('sentinel\n');
});

it('fails on a setu.config.ts it cannot read, and only warns when there is none', async () => {
  expect((await run(['new', 'shop', '--template', 'rest'])).code).toBe(0);
  const project = `${root}/shop`;
  await nodeFs.rm(`${project}/setu.config.ts`);
  const missing = await run(['check', '--dir', project]);
  expect(missing.code).toBe(0);
  expect(missing.err).toContain('warning setu.W002:');
  await nodeFs.mkdir(`${project}/setu.config.ts`);
  const unreadable = await run(['check', '--dir', project]);
  expect(unreadable.code).toBe(1);
  expect(unreadable.err).toContain('error setu.E012: Cannot read setu.config.ts: not-a-file');
  expect(unreadable.err).not.toContain('setu.W002');
  // An unlisted artifact sync would otherwise add — and might double-register, since
  // the hand registrations it must leave out live in the config it cannot read.
  await nodeFs.writeFile(
    `${project}/src/controllers/extra.controller.ts`,
    'export function registerExtraRoutes() {}',
  );
  const barrelPath = `${project}/src/controllers/index.ts`;
  const barrel = await nodeFs.readFile(barrelPath, 'utf8');
  const synced = await run(['sync', '--dir', project]);
  expect(synced.code).toBe(1);
  expect(synced.err).toContain('setu sync wrote nothing: setu.config.ts cannot be read');
  expect(await nodeFs.readFile(barrelPath, 'utf8')).toBe(barrel);
});

it('reports an unreadable artifact, and sync keeps the barrel import it cannot verify', async () => {
  expect((await run(['new', 'shop', '--template', 'rest'])).code).toBe(0);
  const project = `${root}/shop`;
  expect((await run(['generate', 'controller', 'orders', '--dir', project])).code).toBe(0);
  const barrelPath = `${project}/src/controllers/index.ts`;
  const barrel = await nodeFs.readFile(barrelPath, 'utf8');
  // Over the 1 MiB read cap: the scanner cannot tell what it exports.
  const artifact = `${project}/src/controllers/orders.controller.ts`;
  await nodeFs.appendFile(artifact, `// ${'x'.repeat(1024 * 1024)}\n`);
  const checked = await run(['check', '--dir', project]);
  expect(checked.code).toBe(1);
  expect(checked.err).toContain(
    'error setu.E013: Cannot read src/controllers/orders.controller.ts: too-large',
  );
  const synced = await run(['sync', '--dir', project]);
  expect(synced.code).toBe(1);
  expect(synced.err).toContain('setu.E013');
  expect(await nodeFs.readFile(barrelPath, 'utf8')).toBe(barrel);
  // Unlisted, the same file is still reported: it is never silently passed.
  await nodeFs.writeFile(barrelPath, '');
  expect((await run(['check', '--dir', project])).err).toContain('setu.E013');
});

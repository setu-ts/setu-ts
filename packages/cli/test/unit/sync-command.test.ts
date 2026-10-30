import { expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { scanSeamSpecs } from '../../src/seams/registry.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { formatForTarget } from '../../src/utils/prettier-format.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { renderModuleBarrel } from '../../src/schematics/module-barrel.ts';
import {
  renderFunctionalModuleBarrel,
  renderFunctionalModuleIndex,
} from '../../src/seams/modules.ts';

function harness(seed: Readonly<Record<string, string>> = {}) {
  const fs = createFakeFs({ '/app/package.json': '{}', ...seed });
  const log = createRecorder();
  const err = createRecorder();
  return {
    fs,
    log,
    err,
    run: (args: readonly string[], interrupt?: AbortSignal) =>
      runCli(args, {
        fs,
        cwd: '/app',
        now: () => 0,
        log: log.sink,
        error: err.sink,
        ...(interrupt === undefined ? {} : { interrupt }),
      }),
  };
}

it('renders every family with its owning schematic renderer, includes functional services and creates no empty absent barrels', async () => {
  for (const installed of [
    new Set(['queue-plugin', 'cqrs-plugin', 'events-plugin']),
    new Set(['decorator-plugin', 'di-plugin', 'cqrs-plugin', 'events-plugin']),
  ]) {
    const seed: Record<string, string> = {
      '/app/package.json': JSON.stringify({
        dependencies: Object.fromEntries(
          [...installed].map((name) => [`@setu-ts/${name}`, '^0.10.0']),
        ),
      }),
    };
    const specs = scanSeamSpecs(installed);
    const artifacts: Record<string, readonly string[]> = {};
    for (const spec of specs) {
      artifacts[spec.schematic] = ['example'];
      seed[`/app/${spec.dir}/example${spec.suffix}`] = spec
        .importSymbols(deriveNames('example'))
        .map((symbol) => `export const ${symbol} = {};`)
        .join('\n');
    }
    // Every host symbol wired; per-artifact symbols are absent from this config.
    seed['/app/setu.config.ts'] = specs.flatMap((spec) => spec.exports).join(';');
    const h = harness(seed);
    expect(await h.run(['sync']), h.err.text()).toBe(0);
    for (const spec of specs) {
      const formatted = await formatForTarget(
        [{ path: `/app/${spec.barrel}`, managed: true, contents: spec.renderBarrel(artifacts) }],
        'node',
        '/app',
        () => {},
      );
      expect(h.fs.read(`/app/${spec.barrel}`)).toBe(formatted[0].contents);
    }
    expect(await h.run(['sync'])).toBe(0);
    expect(
      h.log.lines
        .slice(-new Set(specs.map((spec) => spec.barrel)).size)
        .every((line) => line.startsWith('unchanged ')),
    ).toBe(true);
  }
  const empty = harness();
  expect(await empty.run(['sync'])).toBe(0);
  expect(empty.fs.writes).toEqual([]);
});

it('renders both activation modes and functional internal barrels while preserving class indexes', async () => {
  for (const mode of ['functional', 'class-based']) {
    const h = harness({
      '/app/package.json': JSON.stringify({
        dependencies: mode === 'class-based' ? { '@setu-ts/decorator-plugin': '^0.10.0' } : {},
      }),
      '/app/setu.config.ts': 'registerModules; MODULES;',
    });
    expect(await h.run(['generate', 'module', 'orders'])).toBe(0);
    const index = h.fs.read('/app/src/modules/orders/index.ts');
    await h.fs.writeFile('/app/src/modules/index.ts', new TextEncoder().encode(''));
    if (mode === 'functional')
      await h.fs.writeFile(
        '/app/src/modules/orders/index.ts',
        new TextEncoder().encode('export function registerOrdersModule() {}'),
      );
    expect(await h.run(['sync']), h.err.text()).toBe(0);
    const expected =
      mode === 'functional'
        ? renderFunctionalModuleBarrel(['orders'])
        : renderModuleBarrel(['orders'], []);
    const files = await formatForTarget(
      [{ path: '/app/src/modules/index.ts', contents: expected }],
      'node',
      '/app',
      () => {},
    );
    expect(h.fs.read('/app/src/modules/index.ts')).toBe(files[0].contents);
    if (mode === 'class-based') expect(h.fs.read('/app/src/modules/orders/index.ts')).toBe(index);
    else {
      const internal = await formatForTarget(
        [
          {
            path: '/app/src/modules/orders/index.ts',
            contents: renderFunctionalModuleIndex(deriveNames('orders'), {
              controller: ['orders'],
            }),
          },
        ],
        'node',
        '/app',
        () => {},
      );
      expect(h.fs.read('/app/src/modules/orders/index.ts')).toBe(internal[0].contents);
    }
  }
});

it('prints a dry-run plan without writing, then fixes drift and leaves non-barrel findings visible', async () => {
  const h = harness({
    '/app/src/controllers/good.controller.ts': 'export function registerGoodRoutes() {}',
    '/app/src/controllers/bad.controller.ts': '',
    '/app/setu.config.ts': 'registerGeneratedRoutes;',
  });
  expect(await h.run(['sync', '--dry-run'])).toBe(0);
  expect(h.log.text()).toContain('would create /app/src/controllers/index.ts');
  expect(h.fs.writes).toEqual([]);
  expect(await h.run(['sync'])).toBe(1);
  expect(h.err.text()).toContain('setu.E001');
  expect(h.fs.read('/app/src/controllers/index.ts')).toContain('./good.controller.ts');
  expect(h.fs.read('/app/src/controllers/bad.controller.ts')).toBe('');
});

it('uses member scope for workspaces and reports write refusals and interruptions', async () => {
  const h = harness({
    '/app/setu.workspace.json': JSON.stringify({
      version: 1,
      runtime: 'node',
      basePort: 3000,
      transport: 'http',
      members: [{ name: 'orders', port: 3000 }],
    }),
    '/app/apps/orders/package.json': '{}',
    '/app/apps/orders/src/controllers/index.ts': 'mine',
    '/app/apps/orders/setu.config.ts': 'registerGeneratedRoutes;',
  });
  expect(await h.run(['sync'])).toBe(0);
  expect(h.log.lines[0]).toContain('orders: updated /app/apps/orders/src/controllers/index.ts');
  const unsafe = harness({ '/app/src/controllers/index.ts/child': '' });
  expect(await unsafe.run(['sync'])).toBe(1);
  expect(unsafe.err.text()).toContain('Cannot sync /app:');
  const interrupted = harness({
    '/app/src/controllers/good.controller.ts': 'export function registerGoodRoutes() {}',
  });
  const controller = new AbortController();
  const write = interrupted.fs.writeFile;
  interrupted.fs.writeFile = async (path, bytes) => {
    await write(path, bytes);
    controller.abort();
  };
  expect(await interrupted.run(['sync'], controller.signal)).toBe(130);
  expect(interrupted.fs.has('/app/src/controllers/index.ts')).toBe(false);
  expect(interrupted.err.text()).toContain('Interrupted; the files this run wrote were removed.');
});

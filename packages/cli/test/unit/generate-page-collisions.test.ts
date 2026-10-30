import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import type { CommandRunner } from '../../src/utils/run-command.ts';

const tree = [
  {
    id: 'layout',
    children: [
      { id: 'products', path: 'products', index: true, file: 'routes/_app/products._index.tsx' },
    ],
  },
];
function harness(
  plugins = ['react-router-plugin'],
  runCommand: CommandRunner = () =>
    Promise.resolve({ code: 0, stdout: JSON.stringify(tree), stderr: '' }),
) {
  const fs = createFakeFs({
    '/app/package.json': JSON.stringify({
      dependencies: Object.fromEntries(plugins.map((p) => [`@setu-ts/${p}`, '^0.10.0'])),
    }),
  });
  const out = createRecorder();
  const err = createRecorder();
  const runner = vi.fn(runCommand);
  return {
    fs,
    out,
    err,
    runner,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/app',
        now: () => 0,
        log: out.sink,
        error: err.sink,
        runCommand: runner,
      }),
  };
}

describe('generation refuses kernel routes that shadow React Router pages', () => {
  for (const schematic of ['route', 'controller', 'module']) {
    for (const dryRun of [false, true]) {
      it(`refuses ${schematic} products before writing or printing a dry-run plan (${dryRun})`, async () => {
        const h = harness();
        expect(await h.run(['g', schematic, 'products', ...(dryRun ? ['--dry-run'] : [])])).toBe(1);
        expect(h.fs.writes).toEqual([]);
        expect(h.out.lines).toEqual([]);
        expect(h.err.text()).toContain('app/routes/_app/products._index.tsx');
        expect(h.err.text()).toContain('/products and /products/:id would take precedence');
        expect(h.err.text()).toContain(
          schematic === 'module'
            ? "Choose another module name: a module's routes are mounted at /<module name>."
            : `setu g module api (with --adopt-controllers if the project has controllers), then setu g ${schematic} products --module api (which yields /api/products)`,
        );
      });
    }
  }
  it('names the requested generator and name in its advice, never a fixed example', async () => {
    const orders = [{ id: 'orders', path: 'orders', file: 'routes/_app/orders.tsx' }];
    const h = harness(undefined, () =>
      Promise.resolve({ code: 0, stdout: JSON.stringify(orders), stderr: '' }),
    );
    expect(await h.run(['g', 'controller', 'orders'])).toBe(1);
    expect(h.err.text()).toContain('app/routes/_app/orders.tsx');
    expect(h.err.text()).toContain(
      'setu g module api (with --adopt-controllers if the project has controllers), then setu g controller orders --module api (which yields /api/orders)',
    );
    expect(h.err.text()).not.toContain('products');
  });
  it('allows /api/products in an existing api module', async () => {
    const h = harness();
    expect(await h.run(['g', 'module', 'api'])).toBe(0);
    expect(await h.run(['g', 'route', 'products', '--module', 'api'])).toBe(0);
    expect(h.fs.read('/app/src/modules/api/products.controller.ts')).toContain('/api/products');
  });
  it('continues with a notice naming the paths to inspect when the CLI fails', async () => {
    const h = harness(undefined, () =>
      Promise.resolve({ code: 127, stdout: '', stderr: '\nmissing CLI\n    at trace line\n' }),
    );
    expect(await h.run(['g', 'route', 'products'])).toBe(0);
    expect(h.err.text()).toContain('Notice: cannot check React Router pages');
    expect(h.err.text()).toContain('React Router exited 127: missing CLI)');
    expect(h.err.text()).not.toContain('trace line');
    expect(h.err.text()).toContain('/products and /products/:id');
    expect(h.fs.writes.length).toBeGreaterThan(0);
  });
  it('never invokes React Router for projects without its plugin or unrelated schematics', async () => {
    for (const [plugins, schematic] of [
      [[], 'route'],
      [['react-router-plugin'], 'service'],
    ] as const) {
      const h = harness([...plugins]);
      expect(await h.run(['g', schematic, 'products'])).toBe(0);
      expect(h.runner).not.toHaveBeenCalled();
    }
  });
});

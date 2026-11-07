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
    '/app/node_modules/.bin/react-router': '',
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
  it('X87-1 refuses a shadowing route in an npm member using the hoisted binary', async () => {
    const fs = createFakeFs({
      '/work/package.json': '{"workspaces":["apps/*"]}',
      '/work/apps/api/package.json': '{"dependencies":{"@setu-ts/react-router-plugin":"^0.11.0"}}',
      '/work/node_modules/.bin/react-router': '',
    });
    const err = createRecorder();
    const runner = vi.fn<CommandRunner>(() =>
      Promise.resolve({ code: 0, stdout: JSON.stringify(tree), stderr: '' }),
    );
    expect(
      await runCli(['g', 'route', 'products'], {
        fs,
        cwd: '/work/apps/api',
        now: () => 0,
        log: () => {},
        error: err.sink,
        runCommand: runner,
      }),
    ).toBe(1);
    expect(err.text()).toContain('would take precedence');
    expect(fs.writes).toEqual([]);
    expect(runner.mock.calls[0]?.[0]).toBe('/work/node_modules/.bin/react-router');
  });
  it('lets a full-stack module share its page name: its routes mount at /api (M130 §3.6)', async () => {
    const h = harness();
    expect(await h.run(['g', 'module', 'products']), h.err.text()).toBe(0);
    expect(h.err.text()).not.toContain('would take precedence');
    expect(h.fs.read('/app/src/modules/products/products.controller.ts')).toContain(
      "router.group('/api/products'",
    );
  });

  it('refuses --page over an existing page, naming its file (review finding 3)', async () => {
    const h = harness();
    expect(await h.run(['g', 'module', 'products', '--page'])).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.err.text()).toContain('the page /products already exists');
    expect(h.err.text()).toContain('routes/_app/products._index.tsx');
  });

  it('allows --page where no page exists yet', async () => {
    const h = harness();
    expect(await h.run(['g', 'module', 'orders', '--page']), h.err.text()).toBe(0);
    expect(h.fs.has('/app/app/routes/_app/orders._index.tsx')).toBe(true);
  });

  it('refuses a full-stack module whose /api routes shadow a page', async () => {
    const api = [{ id: 'api-orders', path: 'api/orders', file: 'routes/_app/api.orders.tsx' }];
    const h = harness(undefined, () =>
      Promise.resolve({ code: 0, stdout: JSON.stringify(api), stderr: '' }),
    );
    expect(await h.run(['g', 'module', 'orders'])).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.err.text()).toContain('/api/orders and /api/orders/:id would take precedence');
    expect(h.err.text()).toContain('routes/_app/api.orders.tsx');
  });

  for (const schematic of ['route', 'controller']) {
    for (const dryRun of [false, true]) {
      it(`refuses ${schematic} products before writing or printing a dry-run plan (${dryRun})`, async () => {
        const h = harness();
        expect(await h.run(['g', schematic, 'products', ...(dryRun ? ['--dry-run'] : [])])).toBe(1);
        expect(h.fs.writes).toEqual([]);
        expect(h.out.lines).toEqual([]);
        expect(h.err.text()).toContain('app/routes/_app/products._index.tsx');
        expect(h.err.text()).toContain('/products and /products/:id would take precedence');
        expect(h.err.text()).toContain(
          `setu g module api (with --adopt-controllers if the project has controllers), then setu g ${schematic} products --module api (which yields /api/products)`,
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

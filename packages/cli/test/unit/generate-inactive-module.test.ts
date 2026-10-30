/**
 * Command-level tests for reporting a feature module whose activation was
 * removed, in both generator modes and under `--dry-run`.
 *
 * The module scanner admits a module from its files, never from its
 * activation, so `setu generate … --module` used to write into a module whose
 * routes could not be reached and say nothing. These tests drive the report
 * through the real command so the barrel and config reads stay covered.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder, type FakeFs, type Recorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';

const FUNCTIONAL_MANIFEST = JSON.stringify({
  imports: { '@setu-ts/logger-plugin': 'jsr:@setu-ts/logger-plugin@^0.1.0-alpha.1' },
});

const CLASS_BASED_MANIFEST = JSON.stringify({
  imports: {
    '@setu-ts/decorator-plugin': 'jsr:@setu-ts/decorator-plugin@^0.1.0-alpha.1',
    '@setu-ts/di-plugin': 'jsr:@setu-ts/di-plugin@^0.1.0-alpha.1',
  },
});

const INACTIVE_HEADER =
  'Module "orders" is not activated in src/modules/index.ts, so its routes are unreachable; add:';

/** A config that never consumes the activation barrel. */
const CONFIG_UNWIRED = 'export function createApp() {}\n';

/** A functional config that calls the activation registrar. */
const CONFIG_FUNCTIONAL_WIRED = [
  "import { registerModules } from './src/modules/index.ts';",
  '',
  'export function createApp(app) {',
  '  registerModules(app.router, app.services);',
  '}',
  '',
].join('\n');

/** A class-based config that passes the aggregate array to `DecoratorPlugin`. */
const CONFIG_CLASS_WIRED = [
  "import { MODULES, registerModules } from './src/modules/index.ts';",
  '',
  'export const config = DecoratorPlugin({ modules: [...MODULES] });',
  'registerModules(app.router, app.services);',
  '',
].join('\n');

/** A class-based config with the class controllers wired but not the function ones. */
const CONFIG_CLASS_NO_REGISTRAR = [
  "import { MODULES } from './src/modules/index.ts';",
  '',
  'export const config = DecoratorPlugin({ modules: [...MODULES] });',
  '',
].join('\n');

/** A config the source mask refuses to classify. */
const CONFIG_UNCLASSIFIABLE = 'const message = `a template literal cannot be classified`;\n';

interface Harness {
  readonly fs: FakeFs;
  readonly out: Recorder;
  readonly err: Recorder;
  run(argv: readonly string[]): Promise<number>;
}

interface StepResult {
  readonly code: number;
  readonly err: string;
  readonly out: string;
  readonly writes: readonly string[];
}

/**
 * Runs one command and returns only the output and writes it produced, so a
 * setup command's report cannot satisfy an assertion meant for the step under
 * test.
 *
 * @param h - The harness to run through
 * @param argv - Arguments after the program name
 * @returns The exit code and the step's own output and writes
 */
async function runStep(h: Harness, argv: readonly string[]): Promise<StepResult> {
  const errAt = h.err.lines.length;
  const outAt = h.out.lines.length;
  const writesAt = h.fs.writes.length;
  const code = await h.run(argv);
  return {
    code,
    err: h.err.lines.slice(errAt).join('\n'),
    out: h.out.lines.slice(outAt).join('\n'),
    writes: h.fs.writes.slice(writesAt),
  };
}

function harness(seed: Readonly<Record<string, string>>): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runGenerateCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        now: () => Date.UTC(2026, 6, 28, 12, 30, 45),
        log: out.sink,
        error: err.sink,
      }),
  };
}

function functionalHarness(config?: string): Harness {
  return harness({
    '/app/deno.json': FUNCTIONAL_MANIFEST,
    ...(config === undefined ? {} : { '/app/setu.config.ts': config }),
  });
}

function classHarness(config?: string): Harness {
  return harness({
    '/app/deno.json': CLASS_BASED_MANIFEST,
    ...(config === undefined ? {} : { '/app/setu.config.ts': config }),
  });
}

/**
 * Simulates a developer removing the generated module from the activation
 * barrel by dropping every line that names it.
 *
 * @param h - The harness whose barrel to rewrite
 */
async function removeActivation(h: Harness): Promise<void> {
  const barrel = h.fs.read('/app/src/modules/index.ts');
  await h.fs.writeFile(
    '/app/src/modules/index.ts',
    new TextEncoder().encode(
      barrel
        .split('\n')
        .filter((line) => !line.includes('OrdersModule'))
        .join('\n'),
    ),
  );
}

describe('setu generate --module reports an inactive module', () => {
  it('reports a functional module whose activation line was removed and still writes', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await removeActivation(h);

    const step = await runStep(h, ['route', 'summary', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
    expect(step.err).toContain("  import { registerOrdersModule } from './orders/index.ts';");
    expect(step.err).toContain('  registerOrdersModule(router, services);');
    expect(step.writes).toContain('/app/src/modules/orders/summary.controller.ts');
  });

  it('reports a module that is imported by the barrel but no longer called or listed', async () => {
    for (const [make, used] of [
      [functionalHarness, '  registerOrdersModule(router, services);'],
      [classHarness, '  OrdersModule,'],
    ] as const) {
      const h = make(make === functionalHarness ? CONFIG_FUNCTIONAL_WIRED : CONFIG_CLASS_WIRED);
      expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
      const barrel = h.fs.read('/app/src/modules/index.ts');
      // Keep the import, drop only the use: an import alone activates nothing.
      const edited = barrel
        .split('\n')
        .filter((line) => line.includes('import') || !line.includes('OrdersModule'))
        .join('\n');
      expect(edited).toContain('OrdersModule');
      expect(edited).not.toContain(used);
      await h.fs.writeFile('/app/src/modules/index.ts', new TextEncoder().encode(edited));

      const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

      expect(step.code).toBe(0);
      expect(step.err).toContain(INACTIVE_HEADER);
    }
  });

  it('keeps the statement after a semicolonless import when reading the config', async () => {
    const h = functionalHarness(
      [
        "import { registerModules } from './src/modules/index.ts'",
        '',
        'export function createApp(app) {',
        '  registerModules(app.router, app.services);',
        '}',
        '',
      ].join('\n'),
    );
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).not.toContain('does not reference registerModules');
    expect(step.err).not.toContain(INACTIVE_HEADER);
  });

  it('reports a class-based module referenced in the barrel but left out of MODULES', async () => {
    const h = classHarness(CONFIG_CLASS_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    const barrel = h.fs.read('/app/src/modules/index.ts');
    // Out of MODULES, but still exported under another name: not activation.
    const edited =
      barrel.replace(/(export const MODULES[^=]*= \[)[^\]]*\]/, '$1]') +
      '\nexport const ORDERS = OrdersModule;\n';
    expect(edited).toContain('export const ORDERS = OrdersModule;');
    await h.fs.writeFile('/app/src/modules/index.ts', new TextEncoder().encode(edited));

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
  });

  it('prints the same report in --dry-run without writing', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await removeActivation(h);

    const step = await runStep(h, ['route', 'summary', '--module', 'orders', '--dry-run']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
    expect(step.err).toContain("  import { registerOrdersModule } from './orders/index.ts';");
    expect(step.err).toContain('  registerOrdersModule(router, services);');
    expect(step.writes).toEqual([]);
    expect(h.fs.has('/app/src/modules/orders/summary.controller.ts')).toBe(false);
  });

  it('names the config import when the barrel is active but the config is not wired', async () => {
    const h = functionalHarness(CONFIG_UNWIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain('setu.config.ts does not reference registerModules; add:');
    expect(step.err).toContain("  import { registerModules } from './src/modules/index.ts';");
    expect(step.err).toContain('  registerModules(app.router, app.services);');
    expect(step.err).not.toContain(INACTIVE_HEADER);
  });

  it('reports an unclassifiable config instead of assuming the module is wired', async () => {
    const h = functionalHarness(CONFIG_UNCLASSIFIABLE);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain('setu.config.ts does not reference registerModules; add:');
    expect(step.err).not.toContain(INACTIVE_HEADER);
  });

  it('stays silent when the config file is absent', async () => {
    const h = functionalHarness();
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).not.toContain('not activated');
    expect(step.err).not.toContain('setu.config.ts');
  });

  it('stays silent when the module is active and the config wired', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).not.toContain('not activated');
    expect(step.err).not.toContain('does not reference');
  });

  it('does not read a symbol mentioned only in a comment as activation', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await removeActivation(h);
    const barrel = h.fs.read('/app/src/modules/index.ts');
    await h.fs.writeFile(
      '/app/src/modules/index.ts',
      new TextEncoder().encode(`// registerOrdersModule is temporarily disabled\n${barrel}`),
    );

    const step = await runStep(h, ['route', 'summary', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
  });

  it('treats an unclassifiable activation barrel as inactive', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    const barrel = h.fs.read('/app/src/modules/index.ts');
    await h.fs.writeFile(
      '/app/src/modules/index.ts',
      new TextEncoder().encode(`${barrel}\nconst label = \`unclassifiable\`;\n`),
    );

    const step = await runStep(h, ['route', 'summary', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
  });

  it('reports a missing activation barrel as inactive', async () => {
    const h = functionalHarness(CONFIG_FUNCTIONAL_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await h.fs.rm('/app/src/modules/index.ts');

    const step = await runStep(h, ['route', 'summary', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
  });

  it('reports a class-based module whose MODULES entry was removed', async () => {
    const h = classHarness(CONFIG_CLASS_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await removeActivation(h);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
    expect(step.err).toContain("  import { OrdersModule } from './orders/orders.module.ts';");
    expect(step.err).toContain('  OrdersModule in MODULES');
    expect(step.writes).toContain('/app/src/modules/orders/pricing.service.ts');
  });

  it('prints the class-based report in --dry-run without writing', async () => {
    const h = classHarness(CONFIG_CLASS_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);
    await removeActivation(h);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders', '--dry-run']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(INACTIVE_HEADER);
    expect(step.err).toContain('  OrdersModule in MODULES');
    expect(step.writes).toEqual([]);
    expect(h.fs.has('/app/src/modules/orders/pricing.service.ts')).toBe(false);
  });

  it('names MODULES when the class-based config is not wired', async () => {
    const h = classHarness(CONFIG_UNWIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(
      'setu.config.ts does not reference MODULES; add it to DecoratorPlugin:',
    );
    expect(step.err).toContain('  modules: [...MODULES]');
    expect(step.err).toContain("  import { MODULES } from './src/modules/index.ts';");
    expect(step.err).not.toContain(INACTIVE_HEADER);
  });

  it('reports an unclassifiable class-based config', async () => {
    const h = classHarness(CONFIG_UNCLASSIFIABLE);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain(
      'setu.config.ts does not reference MODULES; add it to DecoratorPlugin:',
    );
    expect(step.err).not.toContain(INACTIVE_HEADER);
  });

  it('names registerModules when a class-based config wires only MODULES', async () => {
    // A class-based module registers its function controllers from its managed
    // index, so the config needs registerModules beside MODULES.
    const h = classHarness(CONFIG_CLASS_NO_REGISTRAR);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['route', 'audit', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).toContain('setu.config.ts does not reference registerModules; add:');
    expect(step.err).not.toContain('does not reference MODULES');
  });

  it('stays silent for a wired class-based config', async () => {
    const h = classHarness(CONFIG_CLASS_WIRED);
    expect((await runStep(h, ['module', 'orders'])).code).toBe(0);

    const step = await runStep(h, ['service', 'pricing', '--module', 'orders']);

    expect(step.code).toBe(0);
    expect(step.err).not.toContain('not activated');
    expect(step.err).not.toContain('does not reference');
  });
});

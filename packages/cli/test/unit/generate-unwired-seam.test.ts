/**
 * Command-level tests for `setu generate`'s unwired-decorator-barrel report.
 *
 * A generated barrel is managed and lists the artifact, but the developer's
 * `setu.config.ts` may never consume it. The CLI cannot edit that file, so it
 * prints the exact line — unless the export already appears in CODE, where a
 * comment or a string mention does not count.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';

/** A Deno manifest declaring the given `@setu-ts` packages as installed. */
const manifest = (...packages: readonly string[]) =>
  JSON.stringify({
    imports: Object.fromEntries(packages.map((p) => [`@setu-ts/${p}`, `npm:@setu-ts/${p}@^0.9.0`])),
  });

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
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

const CLASS_BASED = manifest('decorator-plugin');

describe('functional module activation guidance', () => {
  for (const config of [
    'export const plugins = [];',
    '// registerModules\nexport const plugins = [];',
    'const text = "registerModules";',
    'export const broken = /unclassifiable/;',
  ]) {
    it(`prints the exact activation lines for an unwired config: ${config}`, async () => {
      const h = harness({ '/app/deno.json': manifest(), '/app/setu.config.ts': config });
      expect(await h.run(['module', 'invoices'])).toBe(0);
      expect(h.err.text()).toContain("import { registerModules } from './src/modules/index.ts';");
      expect(h.err.text()).toContain('registerModules(app.router, app.services);');
    });
  }
  it('does not report a wired functional activation barrel', async () => {
    const h = harness({
      '/app/deno.json': manifest(),
      '/app/setu.config.ts': 'registerModules(app.router, app.services);',
    });
    expect(await h.run(['module', 'invoices'])).toBe(0);
    expect(h.err.text()).not.toContain('does not reference registerModules');
  });
});

describe('setu generate — an unwired decorator barrel is reported', () => {
  it('reports an unconsumed jobs barrel and its import', async () => {
    const h = harness({
      '/app/deno.json': manifest('queue-plugin'),
      '/app/setu.config.ts': 'export const plugins = [];\n',
    });
    expect(await h.run(['job', 'widget'])).toBe(0);
    expect(h.err.text()).toContain(
      'Pass the barrel to QueuePlugin: QueuePlugin({ processors: [...QUEUE_PROCESSORS] })',
    );
    expect(h.err.text()).toContain("import { QUEUE_PROCESSORS } from './src/jobs/index.ts';");
  });
  it('does not report a consumed jobs barrel', async () => {
    const h = harness({
      '/app/deno.json': manifest('queue-plugin'),
      '/app/setu.config.ts': 'export const processors = QUEUE_PROCESSORS;\n',
    });
    expect(await h.run(['job', 'widget'])).toBe(0);
    expect(h.err.text()).not.toContain('Pass the barrel');
  });
  it('prints the starter decorators arm when a starter owns DecoratorPlugin', async () => {
    const h = harness({
      '/app/deno.json': manifest('decorator-plugin', 'full-stack-starter'),
      '/app/setu.config.ts':
        `import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';\n\n` +
        `export default createFullStackAppFromConfig({\n  plugins: [],\n});\n`,
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.text()).toContain(
      'createFullStackAppFromConfig owns DecoratorPlugin; merge the barrel into its decorators arm:',
    );
    expect(h.err.text()).toContain('  decorators: { services: [...APP_SERVICES] }');
    expect(h.err.text()).toContain("  import { APP_SERVICES } from './src/services/index.ts';");
  });

  it('prints the inline DecoratorPlugin line when no starter composes the app', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts': 'export const plugins = [];\n',
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.text()).toContain(
      'setu.config.ts does not reference APP_SERVICES; add it to DecoratorPlugin:',
    );
    expect(h.err.text()).toContain('  services: [...APP_SERVICES]');
    expect(h.err.text()).toContain("  import { APP_SERVICES } from './src/services/index.ts';");
  });

  it('reports nothing when the config references the export in code', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts':
        `import { APP_SERVICES } from './src/services/index.ts';\n` +
        `export const plugins = [{ services: [...APP_SERVICES] }];\n`,
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.lines).toEqual([]);
  });

  it('does not count a mention in a comment as wired', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts':
        `// DecoratorPlugin({ services: [...APP_SERVICES] })\n` + `export const plugins = [];\n`,
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.text()).toContain('setu.config.ts does not reference APP_SERVICES;');
  });

  it('does not count a mention in a string as wired', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts': `export const note = 'APP_SERVICES';\nexport const plugins = [];\n`,
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.text()).toContain('setu.config.ts does not reference APP_SERVICES;');
  });

  it('reports when the config cannot be classified', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts': 'const note = `APP_SERVICES`;\nexport const plugins = [];\n',
    });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.text()).toContain('setu.config.ts does not reference APP_SERVICES;');
  });

  it('reports nothing when the project has no config to point at', async () => {
    const h = harness({ '/app/deno.json': CLASS_BASED });

    expect(await h.run(['service', 'billing'])).toBe(0);

    expect(h.err.lines).toEqual([]);
  });

  it('maps a class-based route through the shared controllers barrel', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED,
      '/app/setu.config.ts': 'export const plugins = [];\n',
    });

    expect(await h.run(['route', 'admin'])).toBe(0);

    expect(h.err.text()).toContain(
      'setu.config.ts does not reference APP_CONTROLLERS; add it to DecoratorPlugin:',
    );
    expect(h.err.text()).toContain('  controllers: [...APP_CONTROLLERS]');
    expect(h.err.text()).toContain(
      "  import { APP_CONTROLLERS } from './src/controllers/index.ts';",
    );
  });

  it('maps an ingress schematic to the ingress arm', async () => {
    const h = harness({
      '/app/deno.json': manifest('decorator-plugin', 'queue-plugin'),
      '/app/setu.config.ts': 'export const plugins = [];\n',
    });

    expect(await h.run(['job', 'nightly'])).toBe(0);

    expect(h.err.text()).toContain(
      'setu.config.ts does not reference INGRESS_HANDLERS; add it to DecoratorPlugin:',
    );
    expect(h.err.text()).toContain('  ingress: [...INGRESS_HANDLERS]');
    expect(h.err.text()).toContain("  import { INGRESS_HANDLERS } from './src/ingress/index.ts';");
  });
});

it('names the queue starter arm for an unwired processors barrel', async () => {
  const h = harness({
    '/app/deno.json': manifest('queue-plugin'),
    '/app/setu.config.ts':
      "import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';",
  });
  expect(await h.run(['job', 'email'])).toBe(0);
  expect(h.err.text()).toContain(
    'createFullStackAppFromConfig owns QueuePlugin; merge the barrel into its queue arm:',
  );
  expect(h.err.text()).toContain('queue: { processors: [...QUEUE_PROCESSORS] }');
  expect(h.err.text()).not.toContain('Pass the barrel to QueuePlugin:');
});
it('refuses an uninstalled starter-owned job queue before writing, including dry-run', async () => {
  for (const [pkg, symbol] of [
    ['full-stack-starter', 'createFullStackAppFromConfig'],
    ['microservice-starter', 'createMicroserviceApp'],
  ] as const) {
    for (const dryRun of [false, true]) {
      const h = harness({
        '/app/deno.json': manifest(),
        '/app/setu.config.ts': `import { ${symbol} } from '@setu-ts/${pkg}';`,
      });
      expect(await h.run(['job', 'email', ...(dryRun ? ['--dry-run'] : [])])).toBe(1);
      expect(h.fs.writes).toEqual([]);
      expect(h.out.lines).toEqual([]);
      expect(h.err.text()).toContain(
        'The "job" schematic requires @setu-ts/queue-plugin, which is not installed in /app.',
      );
      expect(h.err.text()).toContain(
        `${symbol} already runs queue-plugin; add installs its package and wires the generated handlers into setu.config.ts.`,
      );
      expect(h.err.text()).toContain('add queue');
    }
  }
});
it('keeps functional jobs ungated without a queue-owning starter', async () => {
  for (const config of ['', "import { createRestApp } from '@setu-ts/rest-starter';"]) {
    const h = harness({ '/app/deno.json': manifest(), '/app/setu.config.ts': config });
    expect(await h.run(['job', 'email'])).toBe(0);
    expect(h.fs.read('/app/src/jobs/email.job.ts')).toContain('runEmailJob');
    expect(h.err.text()).not.toContain('already runs queue-plugin');
  }
});
it('explains starter-owned plugin gates before the add command', async () => {
  const h = harness({
    '/app/deno.json': manifest(),
    '/app/setu.config.ts':
      "import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';",
  });
  expect(await h.run(['event-handler', 'placed'])).toBe(1);
  expect(h.err.text()).toContain(
    'createFullStackAppFromConfig already runs events-plugin; add installs its package and wires the generated handlers into setu.config.ts.',
  );
  expect(h.err.text().indexOf('already runs')).toBeLessThan(h.err.text().indexOf('Run `'));
});

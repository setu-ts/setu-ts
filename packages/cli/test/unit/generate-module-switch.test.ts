/**
 * The first `setu g module` switches a flat project to modules (§4.7): it refuses
 * while controllers or services live outside modules, or moves them with
 * `--adopt-controllers`, rewriting imports and the config, all or nothing.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { runGenerateCommand } from '../../src/commands/generate.ts';
import { parseArgs } from '../../src/args.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';
import type { TemplateHost } from '../../src/templates/registry.ts';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { generateModule } from '../../src/schematics/module.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { planModuleSwitch } from '../../src/utils/module-switch.ts';

type Style = 'functional' | 'class-based';

function scaffold(host: TemplateHost, extra: Readonly<Record<string, string>> = {}) {
  const seed: Record<string, string> = {};
  for (const file of projectFiles('svc', 'node', resolveHost(host, 'node')))
    seed[`/app/${file.path}`] = file.contents;
  for (const [path, contents] of Object.entries(extra)) seed[`/app/${path}`] = contents;
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  const run = (argv: readonly string[]): Promise<number> =>
    runGenerateCommand(parseArgs(argv), {
      fs,
      cwd: '/app',
      now: () => 0,
      log: out.sink,
      error: err.sink,
    });
  return { fs, out, err, run };
}

function host(style: Style): TemplateHost {
  return style === 'class-based' ? REST_TEMPLATE.classBased! : REST_TEMPLATE;
}

function syntaxErrors(source: string): readonly ts.Diagnostic[] {
  return (
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }).diagnostics ?? []
  );
}

function snapshot(fs: FakeFs, paths: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(paths.map((path) => [path, fs.has(path) ? fs.read(path) : undefined]));
}

describe('the first setu g module', () => {
  for (const style of ['functional', 'class-based'] as const) {
    it(`${style}: refuses while flat controllers or services exist, naming them`, async () => {
      for (const module of ['shipment', 'billing']) {
        const h = scaffold(host(style));
        expect(await h.run(['controller', 'orders'])).toBe(0);
        const writes = h.fs.writes.length;
        expect(await h.run(['module', module])).toBe(1);
        expect(h.fs.writes.length).toBe(writes);
        expect(h.err.text()).toContain(
          [
            'Cannot create the first module while controllers or services live outside modules; a project keeps them in one place:',
            '  src/controllers/greeting.controller.ts',
            '  src/controllers/orders.controller.ts',
            '  src/services/greeting.service.ts',
            `Move them into src/modules/${module}/ with \`npx @setu-ts/cli@`,
          ].join('\n'),
        );
        expect(h.err.text()).toContain(
          `g module ${module} --adopt-controllers\` (their URLs stay the same),`,
        );
      }
    });

    it(`${style}: --adopt-controllers moves them, rewrites imports and switches the config`, async () => {
      const h = scaffold(host(style), {
        'src/controllers/admin/users.controller.ts':
          "import { describeGreeting } from '../../services/greeting.service';\nexport const users = describeGreeting;\n",
        'test/orders.test.ts':
          "import { registerOrdersRoutes } from '../src/controllers/orders.controller.ts';\nexport const r = registerOrdersRoutes;\n",
        'src/shared/unrelated.ts': 'export const unrelated = 1;\n',
      });
      expect(await h.run(['controller', 'orders'])).toBe(0);
      const greeting = h.fs.read('/app/src/controllers/greeting.controller.ts');
      const orders = h.fs.read('/app/src/controllers/orders.controller.ts');
      const config = h.fs.read('/app/setu.config.ts');

      expect(await h.run(['module', 'shipment', '--adopt-controllers'])).toBe(0);

      for (const gone of [
        'src/controllers/greeting.controller.ts',
        'src/controllers/orders.controller.ts',
        'src/controllers/admin/users.controller.ts',
        'src/services/greeting.service.ts',
        'src/controllers/index.ts',
        'src/services/index.ts',
      ])
        expect(h.fs.has(`/app/${gone}`), gone).toBe(false);
      // Only the import line changes; the routes, and so the URLs, stay.
      expect(h.fs.read('/app/src/modules/shipment/greeting.controller.ts')).toBe(
        greeting.replace("'../services/greeting.service.ts'", "'./greeting.service.ts'"),
      );
      expect(h.fs.read('/app/src/modules/shipment/orders.controller.ts')).toBe(orders);
      expect(h.fs.read('/app/src/modules/shipment/admin/users.controller.ts')).toBe(
        "import { describeGreeting } from '../greeting.service';\nexport const users = describeGreeting;\n",
      );
      expect(h.fs.read('/app/test/orders.test.ts')).toBe(
        "import { registerOrdersRoutes } from '../src/modules/shipment/orders.controller.ts';\nexport const r = registerOrdersRoutes;\n",
      );
      expect(h.fs.read('/app/src/shared/unrelated.ts')).toBe('export const unrelated = 1;\n');
      const switched = h.fs.read('/app/setu.config.ts');
      expect(switched).not.toBe(config);
      expect(switched).toContain('registerModules(app.router, app.services);');
      expect(switched).not.toContain('registerGeneratedRoutes');
      expect(syntaxErrors(switched)).toEqual([]);

      const index = h.fs.read('/app/src/modules/shipment/index.ts');
      if (style === 'functional') {
        for (const symbol of [
          'registerGreetingRoutes',
          'registerOrdersRoutes',
          'registerShipmentRoutes',
        ])
          expect(index).toContain(`  ${symbol}(router, services);`);
      } else {
        // Class controllers and services join the declaration; the index carries no class.
        const declaration = h.fs.read('/app/src/modules/shipment/shipment.module.ts');
        expect(declaration).toContain(
          'controllers: [ShipmentController, GreetingController, OrdersController]',
        );
        expect(declaration).toContain('providers: [ShipmentService, GreetingService]');
        expect(declaration).toContain("import { GreetingService } from './greeting.service.ts';");
        expect(syntaxErrors(declaration)).toEqual([]);
        expect(index).not.toContain('Controller');
      }
      // The stale pre-switch wiring is not reported.
      expect(h.err.text()).not.toContain('does not reference registerModules');
      // From now on the project is modular.
      expect(await h.run(['controller', 'tracking'])).toBe(2);
      expect(h.err.text()).toContain(
        'This project uses modules; pass --module <name> (existing: shipment).',
      );
      expect(await h.run(['controller', 'tracking', '--module', 'shipment'])).toBe(0);
    });
  }

  for (const style of ['functional', 'class-based'] as const)
    it(`${style}: moves the untouched scaffold example without --adopt-controllers`, async () => {
      for (const reflow of [false, true]) {
        const h = scaffold(host(style));
        if (reflow) {
          // What a formatter may do to the example: whitespace only.
          const path = '/app/src/controllers/greeting.controller.ts';
          await h.fs.writeFile(
            path,
            new TextEncoder().encode(h.fs.read(path).replace(/\n {2}/g, '\n    ')),
          );
        }
        expect(await h.run(['module', 'shipment']), `${style} ${reflow}`).toBe(0);
        expect(h.fs.has('/app/src/controllers/greeting.controller.ts')).toBe(false);
        expect(h.fs.has('/app/src/modules/shipment/greeting.controller.ts')).toBe(true);
        expect(h.out.text()).toContain(
          "moved the scaffold's untouched greeting example into the module; its routes keep their URLs",
        );
      }
    });

  it('asks for --adopt-controllers once the example is edited, joined or unreadable', async () => {
    const edited = scaffold(host('functional'));
    const path = '/app/src/services/greeting.service.ts';
    await edited.fs.writeFile(
      path,
      new TextEncoder().encode(edited.fs.read(path).replace('Hello', 'Hi')),
    );
    const joined = scaffold(host('functional'), {
      'src/services/extra.service.ts':
        'export function describeExtra(): string {\n  return "x";\n}\n',
    });
    const unreadable = scaffold(host('class-based'));
    const readFile = unreadable.fs.readFile.bind(unreadable.fs);
    unreadable.fs.readFile = (file) =>
      file === '/app/src/controllers/greeting.controller.ts'
        ? Promise.reject(new Error('permission denied'))
        : readFile(file);
    for (const [label, h] of [
      ['edited', edited],
      ['joined', joined],
      ['unreadable', unreadable],
    ] as const) {
      expect(await h.run(['module', 'shipment']), label).toBe(1);
      expect(h.err.text(), label).toContain('g module shipment --adopt-controllers');
    }
  });

  it('switches a project whose flat homes hold only barrels, without --adopt-controllers', async () => {
    const h = scaffold(FULL_STACK_TEMPLATE);
    expect(h.fs.has('/app/src/controllers/index.ts')).toBe(true);
    expect(await h.run(['module', 'catalog'])).toBe(0);
    expect(h.fs.has('/app/src/controllers/index.ts')).toBe(false);
    expect(h.out.text()).toContain('removed src/controllers/index.ts');
    const config = h.fs.read('/app/setu.config.ts');
    expect(config).toContain("import { registerModules } from './src/modules/index.ts';");
    expect(config).not.toContain('registerGeneratedRoutes');
  });

  it('prints the plan on --dry-run and writes nothing', async () => {
    const h = scaffold(host('functional'));
    const before = h.fs.writes.length;
    expect(await h.run(['module', 'shipment', '--adopt-controllers', '--dry-run'])).toBe(0);
    expect(h.fs.writes.length).toBe(before);
    expect(h.out.text()).toContain(
      'would move src/controllers/greeting.controller.ts -> src/modules/shipment/greeting.controller.ts',
    );
    expect(h.out.text()).toContain('would remove src/controllers/index.ts');
    expect(h.err.text()).not.toContain('does not reference registerModules');
  });

  it('reports in a dry run a move the real run would refuse', async () => {
    const h = scaffold(host('functional'), {
      // Not an admitted module (no index.ts), but it holds the destination.
      'src/modules/shipment/greeting.service.ts': 'export const stray = 1;\n',
    });
    expect(await h.run(['module', 'shipment', '--dry-run'])).toBe(1);
    expect(h.err.text()).toContain(
      'WOULD REFUSE: /app/src/modules/shipment/greeting.service.ts already exists',
    );
    expect(h.out.text()).toContain(
      'would move src/controllers/greeting.controller.ts -> src/modules/shipment/greeting.controller.ts',
    );
    expect(h.out.text()).not.toContain('would move src/services/greeting.service.ts');
    expect(await h.run(['module', 'shipment'])).toBe(1);
    expect(h.err.text()).toContain('Refusing to overwrite existing files:');
  });

  it('refuses, writing nothing, whatever it cannot do exactly', async () => {
    const cases: readonly (readonly [
      string,
      Readonly<Record<string, string>>,
      readonly string[],
      string,
      ((config: string) => string)?,
    ])[] = [
      [
        'an unreadable import',
        { 'src/controllers/lazy.controller.ts': "export const x = require('./x.ts');\n" },
        ['module', 'shipment', '--adopt-controllers'],
        'Cannot rewrite the imports of src/controllers/lazy.controller.ts: a require() call. Nothing was moved.',
      ],
      [
        'an import of a flat barrel',
        { 'src/shared/uses-barrel.ts': "export * from '../controllers/index.ts';\n" },
        ['module', 'shipment', '--adopt-controllers'],
        'src/shared/uses-barrel.ts imports ../controllers/index.ts, a flat barrel the first module removes. Nothing was changed.',
      ],
      [
        "a file landing on the module's own file",
        {
          'src/services/shipment.service.ts':
            'export function describeShipment(): string {\n  return "s";\n}\n',
        },
        ['module', 'shipment', '--adopt-controllers'],
        "Cannot adopt into src/modules/shipment/: these would land on the same file as another file or the module's own:",
      ],
      [
        'a config it cannot switch',
        {},
        ['module', 'shipment', '--adopt-controllers'],
        'setu.config.ts registers src/controllers/ in a shape the CLI does not edit, so nothing was changed.',
        (config: string) =>
          config.replace(
            '  registerGeneratedRoutes(app.router, app.services);',
            '  registerGeneratedRoutes(app.router);',
          ),
      ],
    ];
    for (const [label, extra, argv, message, edit] of cases) {
      const h = scaffold(host('functional'), extra);
      if (edit !== undefined)
        await h.fs.writeFile(
          '/app/setu.config.ts',
          new TextEncoder().encode(edit(h.fs.read('/app/setu.config.ts'))),
        );
      const paths = [
        '/app/setu.config.ts',
        '/app/src/controllers/greeting.controller.ts',
        '/app/src/controllers/index.ts',
        '/app/src/services/greeting.service.ts',
      ];
      const before = snapshot(h.fs, paths);
      const writes = h.fs.writes.length;
      expect(await h.run(argv), label).toBe(1);
      expect(h.err.text(), label).toContain(message);
      expect(h.fs.writes.length, label).toBe(writes);
      expect(snapshot(h.fs, paths), label).toEqual(before);
      expect(h.fs.has('/app/src/modules/index.ts'), label).toBe(false);
    }
  });

  it('restores every moved and removed file when a step fails', async () => {
    const h = scaffold(host('functional'));
    const paths = [
      '/app/setu.config.ts',
      '/app/src/controllers/greeting.controller.ts',
      '/app/src/controllers/index.ts',
      '/app/src/services/greeting.service.ts',
    ];
    const before = snapshot(h.fs, paths);
    const rm = h.fs.rm.bind(h.fs);
    h.fs.rm = (path, options) =>
      path === '/app/src/controllers/index.ts'
        ? Promise.reject(new Error('device busy'))
        : rm(path, options);
    expect(await h.run(['module', 'shipment', '--adopt-controllers'])).toBe(1);
    expect(h.err.text()).toContain('device busy');
    expect(snapshot(h.fs, paths)).toEqual(before);
    expect(h.fs.has('/app/src/modules/shipment/greeting.controller.ts')).toBe(false);
  });

  it('refuses, writing nothing, when the project cannot be read for planning', async () => {
    const h = scaffold(host('functional'), { 'src/shared/a.ts': 'export const a = 1;\n' });
    const readdir = h.fs.readdir.bind(h.fs);
    h.fs.readdir = (path) =>
      path === '/app/src/shared' ? Promise.reject(new Error('permission denied')) : readdir(path);
    const writes = h.fs.writes.length;
    expect(await h.run(['module', 'shipment', '--adopt-controllers'])).toBe(1);
    expect(h.err.text()).toContain(
      'Cannot plan the switch to modules: permission denied. Nothing was changed.',
    );
    expect(h.fs.writes.length).toBe(writes);
  });

  it('switches whatever config it finds: absent, already switched, or flat without barrels', async () => {
    const absent = scaffold(host('functional'));
    await absent.fs.rm('/app/setu.config.ts');
    expect(await absent.run(['module', 'shipment', '--adopt-controllers'])).toBe(0);
    expect(absent.fs.has('/app/setu.config.ts')).toBe(false);
    expect(absent.fs.has('/app/src/modules/shipment/greeting.controller.ts')).toBe(true);

    // Hand-switched already, in an unclassifiable config the editor cannot read.
    const switched = scaffold(FULL_STACK_TEMPLATE);
    const handEdited = `const note = \`app.services\`;\n${switched.fs
      .read('/app/setu.config.ts')
      .replace(
        "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
        "import { registerModules } from './src/modules/index.ts';",
      )
      .replace(
        'registerGeneratedRoutes(app.router, app.services);',
        'registerModules(app.router, app.services);',
      )}`;
    await switched.fs.writeFile('/app/setu.config.ts', new TextEncoder().encode(handEdited));
    expect(await switched.run(['module', 'catalog'])).toBe(0);
    expect(switched.fs.read('/app/setu.config.ts')).toBe(handEdited);
    expect(switched.fs.has('/app/src/controllers/index.ts')).toBe(false);

    // The flat homes already gone: only the config changes.
    const bare = scaffold(host('functional'));
    for (const path of [
      '/app/src/controllers/index.ts',
      '/app/src/controllers/greeting.controller.ts',
      '/app/src/services/greeting.service.ts',
    ])
      await bare.fs.rm(path);
    expect(await bare.run(['module', 'shipment'])).toBe(0);
    expect(bare.fs.read('/app/setu.config.ts')).toContain(
      'registerModules(app.router, app.services);',
    );
  });

  it('refuses a config it cannot read, or one that still names the flat barrels unreadably', async () => {
    const directory = scaffold(host('functional'));
    await directory.fs.rm('/app/setu.config.ts');
    await directory.fs.mkdir('/app/setu.config.ts');
    expect(await directory.run(['module', 'shipment', '--adopt-controllers'])).toBe(1);
    expect(directory.err.text()).toContain(
      'Cannot read setu.config.ts (not-a-file); nothing was changed.',
    );

    const unclassifiable = scaffold(host('functional'));
    const config = unclassifiable.fs.read('/app/setu.config.ts');
    await unclassifiable.fs.writeFile(
      '/app/setu.config.ts',
      new TextEncoder().encode(`const note = \`x\`;\n${config}`),
    );
    expect(await unclassifiable.run(['module', 'shipment', '--adopt-controllers'])).toBe(1);
    expect(unclassifiable.err.text()).toContain(
      'setu.config.ts registers src/controllers/ in a shape the CLI does not edit',
    );
  });

  it('moves non-TypeScript files byte for byte and re-points imports of unmoved files', async () => {
    const h = scaffold(host('functional'), {
      'src/controllers/README.md': '# controllers\n',
      'src/controllers/util.controller.ts':
        "import { shared } from '../shared/shared.ts';\nexport function registerUtilRoutes(): void {\n  void shared;\n}\n",
      'src/shared/shared.ts': 'export const shared = 1;\n',
    });
    const config = h.fs.read('/app/setu.config.ts');
    await h.fs.writeFile(
      '/app/setu.config.ts',
      new TextEncoder().encode(
        `import { registerUtilRoutes } from './src/controllers/util.controller.ts';\n${config}void registerUtilRoutes;\n`,
      ),
    );
    expect(await h.run(['module', 'shipment', '--adopt-controllers'])).toBe(0);
    expect(h.fs.read('/app/src/modules/shipment/README.md')).toBe('# controllers\n');
    expect(h.fs.read('/app/src/modules/shipment/util.controller.ts')).toContain(
      "from '../../shared/shared.ts'",
    );
    expect(h.fs.read('/app/setu.config.ts')).toContain(
      "import { registerUtilRoutes } from './src/modules/shipment/util.controller.ts';",
    );
  });

  it('refuses to adopt a class whose name the new module already binds', async () => {
    // `setu g module` refuses this earlier, as a name conflict; the planner refuses
    // on its own too, so a caller that skips that check still cannot drop a class.
    const h = scaffold(host('class-based'), {
      'src/controllers/admin/shipment.controller.ts': 'export class ShipmentController {}\n',
    });
    const generated = generateModule(deriveNames('shipment'), {
      runtime: 'node',
      plugins: new Set(['decorator-plugin']),
    });
    const plan = await planModuleSwitch({
      fs: h.fs,
      dir: '/app',
      module: 'shipment',
      mode: 'class-based',
      adopt: true,
      artifacts: { controller: ['greeting', 'admin/shipment'], service: ['greeting'] },
      generated,
      cli: 'setu',
    });
    expect(plan).toEqual({
      kind: 'refused',
      lines: [
        "Cannot list ShipmentController in the new module's declaration: another class of that name is already bound there. Nothing was moved.",
      ],
    });
  });

  it('accepts --adopt-controllers only on the first g module', async () => {
    const h = scaffold(host('functional'));
    expect(await h.run(['controller', 'orders', '--adopt-controllers'])).toBe(2);
    expect(h.err.text()).toContain('--adopt-controllers applies only to `g module`');
    expect(await h.run(['module', 'shipment', '--adopt-controllers'])).toBe(0);
    expect(await h.run(['module', 'billing', '--adopt-controllers'])).toBe(2);
    expect(h.err.text()).toContain('--adopt-controllers applies only to the first module');
  });
});

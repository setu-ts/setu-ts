import { describe, expect, it } from 'vitest';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { parseArgs } from '../../src/args.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { listSchematics } from '../../src/schematics/registry.ts';
import ts from 'typescript';

function syntaxErrors(source: string): readonly ts.Diagnostic[] {
  return (
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }).diagnostics ?? []
  );
}

function harness(classBased = false) {
  const fs = createFakeFs({
    '/app/deno.json': JSON.stringify({
      imports: Object.fromEntries(
        [
          'common',
          'validation-plugin',
          'auth-plugin',
          'health-plugin',
          'metrics-plugin',
          'cqrs-plugin',
          'events-plugin',
          'queue-plugin',
          'database-plugin',
          'websocket-plugin',
          'sse-plugin',
          ...(classBased ? ['decorator-plugin', 'di-plugin'] : []),
        ].map((pkg) => [`@setu-ts/${pkg}`, `npm:@setu-ts/${pkg}@^0.9.0`]),
      ),
    }),
    '/app/setu.config.ts': 'export function createApp() {}',
  });
  const out = createRecorder();
  const err = createRecorder();
  const run = (args: readonly string[]): Promise<number> =>
    runGenerateCommand(parseArgs(args), {
      fs,
      cwd: '/app',
      now: () => 0,
      log: out.sink,
      error: err.sink,
    });
  return { fs, out, err, run };
}

describe('feature-scoped generation', () => {
  for (const { name } of listSchematics().filter(
    ({ name }) => !['module', 'service', 'route', 'controller', 'sse', 'schema'].includes(name),
  )) {
    it(`refuses app-wide ${name} with --module`, async () => {
      const h = harness();
      expect(await h.run([name, 'billing', '--module', 'invoices'])).toBe(2);
      expect(h.err.text()).toContain('--module places a feature file');
      expect(h.fs.writes).toEqual([]);
    });
  }
  it('refuses module --module and malformed or missing flag values', async () => {
    for (const args of [
      ['module', 'billing', '--module', 'invoices'],
      ['service', 'billing', '--module'],
      ['service', 'billing', '--module', '../bad'],
    ]) {
      const h = harness();
      expect(await h.run(args)).toBe(2);
      expect(h.fs.writes).toEqual([]);
    }
  });
  it('lists admitted modules when the selected module is unknown', async () => {
    const h = harness();
    expect(await h.run(['module', 'invoices'])).toBe(0);
    expect(await h.run(['service', 'billing', '--module', 'missing'])).toBe(1);
    expect(h.err.text()).toContain('Admitted modules: invoices');
    expect(h.fs.has('/app/src/modules/missing/billing.service.ts')).toBe(false);
  });
  it('reports no admitted modules when none exists', async () => {
    const h = harness();
    expect(await h.run(['service', 'billing', '--module', 'missing'])).toBe(1);
    expect(h.err.text()).toContain('This project has no modules; run `');
  });
  it('refuses a top-level route once the project has modules', async () => {
    const h = harness();
    expect(await h.run(['module', 'invoices'])).toBe(0);
    const writes = h.fs.writes.length;
    // Once the project has modules, nothing is generated outside them.
    expect(await h.run(['route', 'invoices'])).toBe(2);
    expect(h.err.text()).toContain('This project uses modules; pass --module <name>');
    expect(h.fs.writes.length).toBe(writes);
  });
  it('namespaces scoped artifacts and regenerates only the functional module index', async () => {
    const h = harness();
    expect(await h.run(['module', 'invoices'])).toBe(0);
    for (const [kind, name] of [
      ['service', 'pricing'],
      ['route', 'summary'],
      ['controller', 'history'],
      ['schema', 'price'],
    ]) {
      expect(await h.run([kind!, name!, '--module', 'invoices'])).toBe(0);
      expect(await h.run([kind!, name!])).toBe(kind === 'schema' ? 0 : 2);
    }
    const index = h.fs.read('/app/src/modules/invoices/index.ts');
    for (const symbol of [
      'registerInvoicesRoutes',
      'registerSummaryRoutes',
      'registerHistoryRoutes',
    ])
      expect(index).toContain(`${symbol}(router, services)`);
    expect(h.fs.read('/app/src/modules/invoices/summary.controller.ts')).toContain(
      "router.group('/invoices/summary'",
    );
    expect(h.fs.read('/app/src/modules/invoices/history.controller.ts')).toContain(
      "router.group('/invoices/history'",
    );
    expect(h.fs.read('/app/src/modules/index.ts')).not.toContain('registerSummaryRoutes');
    // One controller family: a route and a controller of one name are one file.
    expect(await h.run(['controller', 'summary', '--module', 'invoices'])).toBe(1);
    expect(h.err.text()).toContain(
      'Refusing to overwrite existing files:\n  /app/src/modules/invoices/summary.controller.ts',
    );
    expect(await h.run(['schema', 'invoices', '--module', 'invoices'])).toBe(1);
    expect(h.err.text()).toContain('Refusing to overwrite');
  });
  it('adds class-based controllers and services to a literal @Module declaration', async () => {
    const h = harness(true);
    expect(await h.run(['module', 'invoices'])).toBe(0);
    for (const kind of ['service', 'controller', 'schema']) {
      expect(await h.run([kind, 'pricing', '--module', 'invoices'])).toBe(0);
    }
    const declaration = h.fs.read('/app/src/modules/invoices/invoices.module.ts');
    expect(declaration).toBe(
      [
        "import { Module } from '@setu-ts/decorator-plugin';",
        '',
        "import { InvoicesController } from './invoices.controller.ts';",
        "import { InvoicesService } from './invoices.service.ts';",
        "import { PricingService } from './pricing.service.ts';",
        "import { PricingController } from './pricing.controller.ts';",
        '',
        '/**',
        ' * The invoices module.',
        ' *',
        ' * `setu g controller … --module invoices` and `setu g service … --module invoices`',
        ' * append to these arrays while they are plain array literals; anything else is',
        ' * left as you wrote it. Importing another module activates its controllers and',
        ' * providers too.',
        ' */',
        '@Module({',
        '  controllers: [InvoicesController, PricingController],',
        '  providers: [InvoicesService, PricingService],',
        '})',
        'export class InvoicesModule {}',
        '',
      ].join('\n'),
    );
    expect(syntaxErrors(declaration)).toEqual([]);
    expect(h.fs.read('/app/src/modules/invoices/pricing.service.ts')).toContain(
      "token: 'invoices.pricing-service'",
    );
    expect(h.fs.read('/app/src/modules/invoices/pricing.controller.ts')).toContain(
      "@Controller('/invoices/pricing')",
    );
    expect(h.out.text()).not.toContain('to @Module(');
  });
  it('registers a function controller in a class-based module from its managed index', async () => {
    const h = harness(true);
    expect(await h.run(['module', 'ledger'])).toBe(0);
    const declaration = h.fs.read('/app/src/modules/ledger/ledger.module.ts');
    expect(await h.run(['route', 'export', '--module', 'ledger'])).toBe(0);
    // A function controller is not a class, so the declaration is unchanged.
    expect(h.fs.read('/app/src/modules/ledger/ledger.module.ts')).toBe(declaration);
    const index = h.fs.read('/app/src/modules/ledger/index.ts');
    expect(index).toBe(
      [
        '/** CLI-owned; regenerated by setu generate module or setu generate … --module <name>. */',
        "import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';",
        "import { registerExportRoutes } from './export.controller.ts';",
        "export { LedgerModule } from './ledger.module.ts';",
        '',
        '/** Registers the feature routes. */',
        'export function registerLedgerModule(router: IRouterApi, services?: IServiceRegistry): void {',
        '  registerExportRoutes(router, services);',
        '}',
        '',
      ].join('\n'),
    );
    expect(syntaxErrors(index)).toEqual([]);
    expect(h.fs.read('/app/src/modules/index.ts')).toContain(
      "import { registerLedgerModule } from './ledger/index.ts';",
    );
    expect(h.fs.read('/app/src/modules/index.ts')).toContain(
      '  registerLedgerModule(router, services);',
    );
  });
  it('leaves a declaration it cannot read unchanged and prints the line to add', async () => {
    for (const [label, edit] of [
      [
        'shorthand',
        (source: string) => source.replace('controllers: [InvoicesController],', 'controllers,'),
      ],
      ['spread', (source: string) => source.replace('[InvoicesController]', '[...BASE]')],
      ['two declarations', (source: string) => `${source}\n@Module({})\nexport class Other {}\n`],
    ] as const) {
      const h = harness(true);
      expect(await h.run(['module', 'invoices'])).toBe(0);
      const path = '/app/src/modules/invoices/invoices.module.ts';
      await h.fs.writeFile(path, new TextEncoder().encode(edit(h.fs.read(path))));
      const before = h.fs.read(path);
      expect(await h.run(['controller', 'pricing', '--module', 'invoices']), label).toBe(0);
      expect(h.fs.read(path), label).toBe(before);
      expect(h.out.text(), label).toContain(
        'Add PricingController to @Module({ controllers }) in src/modules/invoices/invoices.module.ts; the CLI edits only a plain array literal there.',
      );
    }
  });
  it('namespaces scoped DI tokens separately from hyphenated top-level services', async () => {
    const h = harness(true);
    // A flat service keeps its token when the first module adopts it.
    expect(await h.run(['service', 'billing-invoice'])).toBe(0);
    expect(await h.run(['module', 'billing', '--adopt-controllers'])).toBe(0);
    expect(await h.run(['service', 'invoice', '--module', 'billing'])).toBe(0);
    const scoped = h.fs.read('/app/src/modules/billing/invoice.service.ts');
    const topLevel = h.fs.read('/app/src/modules/billing/billing-invoice.service.ts');
    expect(scoped).toContain("token: 'billing.invoice-service'");
    expect(topLevel).toContain("token: 'billing-invoice-service'");
    expect(scoped).not.toContain("token: 'billing-invoice-service'");
    expect(scoped).toContain("inject 'billing.invoice-service'");
    expect(h.out.text()).toContain("@Inject('billing.invoice-service')");
    const writes = h.fs.writes.length;
    expect(await h.run(['service', 'billing.invoice'])).toBe(2);
    expect(h.fs.writes.length).toBe(writes);
  });
});

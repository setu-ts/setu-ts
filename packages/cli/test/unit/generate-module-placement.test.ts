import { describe, expect, it } from 'vitest';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { parseArgs } from '../../src/args.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { listSchematics } from '../../src/schematics/registry.ts';

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
    ({ name }) => !['module', 'service', 'route', 'controller', 'schema'].includes(name),
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
    expect(h.err.text()).toContain('(none)');
  });
  it('refuses a top-level duplicate route beside a functional module', async () => {
    const h = harness();
    expect(await h.run(['module', 'invoices'])).toBe(0);
    const writes = h.fs.writes.length;
    expect(await h.run(['route', 'invoices'])).toBe(1);
    expect(h.err.text()).toContain('the HTTP path /invoices');
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
      expect(await h.run([kind!, name!])).toBe(0);
    }
    const index = h.fs.read('/app/src/modules/invoices/index.ts');
    for (const symbol of [
      'registerInvoicesRoutes',
      'registerSummaryRoutes',
      'registerHistoryRoutes',
    ])
      expect(index).toContain(`${symbol}(router, services)`);
    expect(h.fs.read('/app/src/modules/invoices/summary.routes.ts')).toContain(
      "router.group('/invoices/summary'",
    );
    expect(h.fs.read('/app/src/modules/invoices/history.controller.ts')).toContain(
      "router.group('/invoices/history'",
    );
    expect(h.fs.read('/app/src/modules/index.ts')).not.toContain('registerSummaryRoutes');
    expect(await h.run(['controller', 'summary', '--module', 'invoices'])).toBe(1);
    expect(h.err.text()).toContain('claimed by the route');
    expect(await h.run(['schema', 'invoices', '--module', 'invoices'])).toBe(1);
    expect(h.err.text()).toContain('Refusing to overwrite');
  });
  it('allows a scoped route beside an existing top-level controller of the same name', async () => {
    const h = harness();
    expect(await h.run(['module', 'invoices'])).toBe(0);
    expect(await h.run(['controller', 'summary'])).toBe(0);
    expect(await h.run(['route', 'summary', '--module', 'invoices'])).toBe(0);
    expect(h.fs.has('/app/src/modules/invoices/summary.routes.ts')).toBe(true);
  });
  it('places class-based files and prints declaration edits without writing the declaration', async () => {
    const h = harness(true);
    expect(await h.run(['module', 'invoices'])).toBe(0);
    const declaration = h.fs.read('/app/src/modules/invoices/invoices.module.ts');
    for (const kind of ['service', 'controller', 'schema']) {
      expect(await h.run([kind, 'pricing', '--module', 'invoices'])).toBe(0);
      expect(await h.run([kind, 'pricing'])).toBe(0);
    }
    expect(h.fs.read('/app/src/modules/invoices/invoices.module.ts')).toBe(declaration);
    expect(h.fs.read('/app/src/modules/invoices/pricing.service.ts')).toContain(
      "token: 'invoices.pricing-service'",
    );
    expect(h.fs.read('/app/src/modules/invoices/pricing.controller.ts')).toContain(
      "@Controller('/invoices/pricing')",
    );
    expect(h.out.text()).toContain(
      'Add PricingService to @Module({ providers }) in src/modules/invoices/invoices.module.ts',
    );
    expect(h.out.text()).toContain(
      'Add PricingController to @Module({ controllers }) in src/modules/invoices/invoices.module.ts',
    );
    expect(await h.run(['route', 'pricing', '--module', 'invoices'])).toBe(2);
    expect(h.err.text()).toContain('top-level g route');
  });
  it('namespaces scoped DI tokens separately from hyphenated top-level services', async () => {
    const h = harness(true);
    expect(await h.run(['module', 'billing'])).toBe(0);
    expect(await h.run(['service', 'invoice', '--module', 'billing'])).toBe(0);
    expect(await h.run(['service', 'billing-invoice'])).toBe(0);
    const scoped = h.fs.read('/app/src/modules/billing/invoice.service.ts');
    const topLevel = h.fs.read('/app/src/services/billing-invoice.service.ts');
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

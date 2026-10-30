import { describe, expect, it } from 'vitest';
import { generateModule } from '../../../src/schematics/module.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options, gateOf } from './_shared.ts';

describe('generateModule', () => {
  const names = deriveNames('invoices');
  for (const style of ['functional', 'class-based'] as const) {
    for (const [validation, exceptions] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      it(`${style} emits a complete feature with validation=${validation} exceptions=${exceptions}`, () => {
        const plugins = [
          ...(style === 'class-based' ? ['decorator-plugin', 'di-plugin'] : []),
          ...(validation ? ['validation-plugin', 'openapi-plugin'] : []),
          ...(exceptions ? ['exceptions'] : []),
        ];
        const files = generateModule(names, options(plugins, ['zebra', 'billing']));
        const source = (name: string): string =>
          files.find((file) => file.path === `src/modules/invoices/${name}`)!.contents;
        expect(gateOf('module')).toBeUndefined();
        expect(files.some((file) => file.path.startsWith('src/controllers/'))).toBe(false);
        expect(files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            'src/modules/invoices/invoices.service.ts',
            'src/modules/invoices/index.ts',
            'src/modules/index.ts',
            'src/modules/invoices/invoices.test.ts',
            'src/modules/invoices/invoices.e2e.test.ts',
            'test/support/server.ts',
          ]),
        );
        expect(files.some((file) => file.path.endsWith('.schemas.ts'))).toBe(validation);
        const routes = source('invoices.controller.ts');
        expect(routes).toContain("'/invoices'");
        expect(routes).toContain('status(201)');
        // A missing record answers in the application's error format: thrown
        // through `errorHandler` when `exceptions` is installed, otherwise the
        // kernel's own `{ error, detail }` shape — never a hand-rolled body.
        const missing = 'Invoices not found.';
        if (exceptions) {
          expect(routes).toContain("import { notFound } from '@setu-ts/exceptions';");
          expect(routes.match(/throw notFound\('Invoices not found\.'\);/g)).toHaveLength(2);
        } else {
          expect(routes).not.toContain('@setu-ts/exceptions');
          expect(
            routes.split(`.status(404).json({ error: 'Not Found', detail: '${missing}' })`),
          ).toHaveLength(3);
        }
        // The caller's id is not echoed into the detail (V10-35).
        expect(routes).not.toContain('${id}');
        expect(routes).not.toContain("json({ message: 'Not found' })");
        expect(routes).not.toMatch(/\bas\s+(?:z\.|Record|Create|Update|List)/);
        if (validation) {
          const schemas = source('invoices.schemas.ts');
          for (const name of [
            'CreateInvoicesBody',
            'UpdateInvoicesBody',
            'ListInvoicesQuery',
            'InvoicesParams',
            'InvoicesResponse',
            'InvoicesListResponse',
          ]) {
            expect(schemas).toContain(`export const ${name}`);
            expect(schemas).toContain(`export type ${name} = z.infer<typeof ${name}>`);
          }
          expect(schemas).toContain('z.coerce.number()');
          if (style === 'functional') {
            expect(routes).toContain('.value(ctx)');
            expect(routes).toContain('schema: { response:');
          } else {
            for (const decorator of [
              '@ValidateBody',
              '@ValidateQuery',
              '@ValidateParams',
              '@ApiResponse',
              '@Params(Body<CreateInvoicesBody>()',
            ])
              expect(routes).toContain(decorator);
          }
        } else expect(routes).not.toContain('@setu-ts/validation-plugin');
        const service = source('invoices.service.ts');
        expect(service).toContain('crypto.randomUUID()');
        expect(service).toContain('new Map');
        expect(service).toContain('repository');
        const test = source('invoices.test.ts');
        expect(test).toContain('createTestApp({ app: await createApp() })');
        expect(test).toContain('Array.isArray');
        expect(test).not.toContain('toEqual([])');
        const barrel = files.find((file) => file.path === 'src/modules/index.ts')!.contents;
        if (style === 'functional') {
          expect(source('index.ts')).toContain('registerInvoicesModule');
          expect(source('index.ts')).not.toContain('export *');
          expect(barrel).toContain('registerBillingModule(router, services)');
        } else {
          expect(source('invoices.module.ts')).toContain('providers: [InvoicesService]');
          expect(source('index.ts')).toContain('export { InvoicesModule }');
          expect(service).toContain("@Injectable({ token: 'invoices-service' })");
          expect(routes).toContain("@Inject('invoices-service')");
          expect(barrel).toContain('BillingModule');
        }
      });
    }
  }
  it('emits Workers tests that boot the real Worker in either style', () => {
    for (const plugins of [[], ['decorator-plugin', 'validation-plugin']]) {
      const files = generateModule(names, { ...options(plugins), runtime: 'cloudflare-workers' });
      const contentsOf = (path: string): string =>
        files.find((file) => file.path === path)!.contents;
      expect(files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          'src/modules/invoices/invoices.test.ts',
          'src/modules/invoices/invoices.e2e.test.ts',
          'test/support/server.ts',
        ]),
      );
      const test = contentsOf('src/modules/invoices/invoices.test.ts');
      expect(test).toContain("import { startTestServer } from '../../../test/support/server.ts';");
      expect(test).toContain("await fetch(server.baseUrl + '/invoices')");
      expect(test).not.toContain('createTestApp');
      expect(test).toContain("from 'node:test'");
      const server = files.find((file) => file.path === 'test/support/server.ts')!;
      expect(server.managed).toBe(true);
      expect(server.contents).toContain('createTestHarness');
      expect(contentsOf('src/modules/invoices/invoices.e2e.test.ts')).toContain('startTestServer');
    }
  });
  it('keeps activation idempotent and accepts old custom schematic options', () => {
    for (const plugins of [[], ['decorator-plugin']]) {
      const files = generateModule(names, {
        runtime: 'node',
        plugins: new Set(plugins),
        now: () => 0,
      });
      const duplicate = generateModule(names, {
        ...options(plugins, ['invoices']),
        runtime: 'node',
      });
      expect(files.find((file) => file.path === 'src/modules/index.ts')?.contents).toBe(
        duplicate.find((file) => file.path === 'src/modules/index.ts')?.contents,
      );
    }
  });
});

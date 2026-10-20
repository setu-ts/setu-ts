import { describe, expect, it } from 'vitest';
import { generateModule } from '../../../src/schematics/module.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options, gateOf } from './_shared.ts';

describe('generateModule', () => {
  const names = deriveNames('invoices');
  for (const style of ['functional', 'class-based'] as const) {
    for (const validation of [false, true]) {
      it(`${style} emits a complete feature with validation=${validation}`, () => {
        const plugins = [
          ...(style === 'class-based' ? ['decorator-plugin', 'di-plugin'] : []),
          ...(validation ? ['validation-plugin', 'openapi-plugin'] : []),
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
        const routes = source(`invoices.${style === 'class-based' ? 'controller' : 'routes'}.ts`);
        expect(routes).toContain("'/invoices'");
        expect(routes).toContain('status(201)');
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
  it('omits tests on Workers in either style', () => {
    for (const plugins of [[], ['decorator-plugin', 'validation-plugin']]) {
      const files = generateModule(names, { ...options(plugins), runtime: 'cloudflare-workers' });
      expect(files.some((file) => file.path.includes('test'))).toBe(false);
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

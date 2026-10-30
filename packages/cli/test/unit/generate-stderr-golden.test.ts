import { expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

const manifest = (...names: string[]) =>
  JSON.stringify({
    imports: Object.fromEntries(
      names.map((name) => [`@setu-ts/${name}`, `npm:@setu-ts/${name}@^0.10.0`]),
    ),
  });

const cases = [
  {
    name: 'scan reports and legacy notices in order',
    seed: {
      '/app/deno.json': manifest(),
      '/app/src/modules/Bad/bad.controller.ts': '',
      '/app/src/modules/Bad/Bad.controller.ts': '',
      '/app/src/modules/orders/orders.controller.ts': '',
      '/app/src/controllers/Bad.controller.ts': '',
      '/app/src/controllers/broken.controller.ts': '',
      '/app/src/controllers/manual.controller.ts': 'export function registerManualRoutes() {}',
      '/app/src/routes/old.routes.ts': '',
      '/app/setu.config.ts':
        'registerManualRoutes(app.router); registerGeneratedRoutes(app.router);',
    },
    argv: ['generate', 'service', 'pricing'],
    expected: [
      'Skipped src/modules/Bad: its name is not a kebab-case identifier, so it cannot be listed in the activation barrel. Rename the directory.',
      'Skipped src/modules/orders: it is missing registerOrdersModule, so it cannot be listed in the registerModules activation barrel.',
      '  Add registerOrdersModule as an export or delete and regenerate the module.',
      'Skipped src/controllers/Bad.controller.ts: its name is not a kebab-case identifier, so it cannot be listed in the barrel. Rename the file.',
      'Skipped src/controllers/broken.controller.ts: it does not export registerBrokenRoutes, so it cannot be listed in the generated barrel and nothing registers it.',
      '  Add that export to the file — or rename an existing one — or delete the file and run this schematic again.',
      'Skipped src/controllers/manual.controller.ts: registerManualRoutes is already registered by hand in setu.config.ts, so listing it in the generated barrel would register it twice.',
      '  Remove the manual registration to let the barrel own it, or leave it as it is.',
      'src/routes/ still holds 1 file(s): old.routes.ts.',
      '  That directory was merged into src/controllers/. Until you move them, src/controllers/index.ts is',
      '  imported by nothing and everything generated into it is unreachable.',
      '  Move them, delete src/routes/, and point setu.config.ts at ./src/controllers/index.ts.',
      'setu.config.ts calls registerGeneratedRoutes(app.router) without the service registry.',
      '  Generated artifacts that resolve a capability — an SSE controller does — receive',
      '  `undefined` and throw at startup.',
      '  Change the call to registerGeneratedRoutes(app.router, app.services).',
    ],
  },
  {
    name: 'adoption and unwired class controller',
    seed: {
      '/app/deno.json': manifest('decorator-plugin', 'di-plugin'),
      '/app/src/controllers/admin.controller.ts': 'export class AdminController {}',
      '/app/setu.config.ts': 'export const config = {};',
    },
    argv: ['generate', 'controller', 'users'],
    expected: [
      "Adopted src/controllers/admin.controller.ts into src/controllers/index.ts: it matches this family's naming convention, so the generated barrel registers it.",
      '  Remove any manual registration of it, or rename the file.',
      'setu.config.ts does not reference APP_CONTROLLERS; add it to DecoratorPlugin:',
      '  controllers: [...APP_CONTROLLERS]',
      "  import { APP_CONTROLLERS } from './src/controllers/index.ts';",
    ],
  },
  {
    name: 'starter remedy',
    seed: {
      '/app/deno.json': manifest('decorator-plugin', 'di-plugin'),
      '/app/setu.config.ts': "import { createRestApp } from '@setu-ts/rest-starter';",
    },
    argv: ['generate', 'service', 'pricing'],
    expected: [
      'createRestApp owns DecoratorPlugin; merge the barrel into its decorators arm:',
      '  decorators: { services: [...APP_SERVICES] }',
      "  import { APP_SERVICES } from './src/services/index.ts';",
    ],
  },
  {
    name: 'unwired jobs',
    seed: {
      '/app/deno.json': manifest('queue-plugin'),
      '/app/setu.config.ts': 'export const config = {};',
    },
    argv: ['generate', 'job', 'nightly'],
    expected: [
      'Pass the barrel to QueuePlugin: QueuePlugin({ processors: [...QUEUE_PROCESSORS] })',
      "  import { QUEUE_PROCESSORS } from './src/jobs/index.ts';",
    ],
  },
  {
    name: 'unwired functional modules',
    seed: { '/app/deno.json': manifest(), '/app/setu.config.ts': 'export const config = {};' },
    argv: ['generate', 'module', 'orders'],
    expected: [
      'setu.config.ts does not reference registerModules; add:',
      "  import { registerModules } from './src/modules/index.ts';",
      '  registerModules(app.router, app.services);',
    ],
  },
  {
    name: 'class legacy module',
    seed: {
      '/app/deno.json': manifest('decorator-plugin'),
      '/app/src/modules/orders/orders.controller.ts': 'export class OrdersController {}',
      '/app/src/modules/orders/orders.service.ts': 'export class OrdersService {}',
    },
    argv: ['generate', 'service', 'pricing'],
    expected: [
      'Skipped src/modules/orders: it is missing orders.module.ts, so it cannot be listed in the MODULES activation barrel.',
      '  Add orders.module.ts with @Module(...) or delete and regenerate the module.',
    ],
  },
  {
    name: 'functional module target and inactive warning',
    seed: {
      '/app/deno.json': manifest(),
      '/app/src/modules/orders/orders.controller.ts': 'export function registerOrdersRoutes() {}',
      '/app/src/modules/orders/index.ts': 'export function registerOrdersModule() {}',
    },
    argv: ['generate', 'controller', 'summary', '--module', 'orders', '--dry-run'],
    expected: [
      "Would adopt src/modules/orders/orders.controller.ts into src/modules/orders/index.ts: it matches this family's naming convention, so the generated barrel registers it.",
      '  Remove any manual registration of it, or rename the file.',
      'Module "orders" is not activated in src/modules/index.ts, so its routes are unreachable; add:',
      "  import { registerOrdersModule } from './orders/index.ts';",
      '  registerOrdersModule(router, services);',
    ],
  },
] as const;

for (const fixture of cases) {
  it(`pins generate stderr: ${fixture.name}`, async () => {
    const fs = createFakeFs(fixture.seed);
    const err = createRecorder();
    expect(
      await runCli(fixture.argv, { fs, cwd: '/app', now: () => 0, log: () => {}, error: err.sink }),
    ).toBe(0);
    expect(err.lines).toEqual(fixture.expected);
  });
}

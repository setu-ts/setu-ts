/**
 * The `module-service` family (M130 §3.4, maintainer decision option A): a
 * full-stack module's request-bound service registration is derived from the
 * module's scanned `<m>.token.ts`, so every writer of the managed index renders
 * it and no regeneration can erase it.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { MODULE_SERVICE_ARTIFACTS, renderFunctionalModuleIndex } from '../../src/seams/modules.ts';
import { scanModuleArtifacts } from '../../src/utils/module-scanner.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

const REGISTER_LINE = 'services.register(ORDERS, requestService(ordersService));';
const FULL_STACK = JSON.stringify({
  dependencies: { '@setu-ts/react-router-plugin': '^0.11.0', '@setu-ts/common': '^0.11.0' },
});
const TOKEN = `import { serviceToken } from '@setu-ts/common';
import type { OrdersService } from './orders.service.ts';
export const ORDERS = serviceToken<OrdersService>('module.orders');
`;
const SERVICE = `export interface OrdersService { list(): Promise<readonly string[]> }
export function ordersService(): OrdersService { return { list: () => Promise.resolve([]) }; }
`;
const CONTROLLER = `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
export function registerOrdersRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void router;
  void services;
}
`;

function harness(seed: Readonly<Record<string, string>>) {
  const fs = createFakeFs({ '/app/setu.config.ts': 'registerModules;', ...seed });
  const log = createRecorder();
  const err = createRecorder();
  return {
    fs,
    err,
    run: (args: readonly string[]) =>
      runCli(args, { fs, cwd: '/app', now: () => 0, log: log.sink, error: err.sink }),
  };
}

function moduleSeed(manifest: string, token: string | undefined): Record<string, string> {
  return {
    '/app/package.json': manifest,
    '/app/src/modules/index.ts': "import { registerOrdersModule } from './orders/index.ts';\n",
    '/app/src/modules/orders/orders.service.ts': SERVICE,
    '/app/src/modules/orders/orders.controller.ts': CONTROLLER,
    // The index as written before the token existed: sync must add the line.
    '/app/src/modules/orders/index.ts': renderFunctionalModuleIndex(deriveNames('orders'), {
      controller: ['orders'],
    }),
    ...(token === undefined ? {} : { '/app/src/modules/orders/orders.token.ts': token }),
  };
}

describe('renderFunctionalModuleIndex with a module service', () => {
  it('registers the token ahead of the routes and refuses a missing registry', () => {
    const source = renderFunctionalModuleIndex(deriveNames('orders'), {
      controller: ['orders'],
      [MODULE_SERVICE_ARTIFACTS]: ['orders'],
    });
    expect(source).toContain(
      "import { requestService, type IRouterApi, type IServiceRegistry } from '@setu-ts/common';",
    );
    expect(source).toContain("import { ordersService } from './orders.service.ts';");
    expect(source).toContain("import { ORDERS } from './orders.token.ts';");
    expect(source.indexOf(REGISTER_LINE)).toBeGreaterThan(-1);
    expect(source.indexOf(REGISTER_LINE)).toBeLessThan(
      source.indexOf('registerOrdersRoutes(router, services);'),
    );
    expect(source).toContain('if (services === undefined) {');
    expect(source).toContain('registerOrdersModule needs the service registry');
  });

  it('keeps a service-only module valid and leaves other indexes unchanged', () => {
    const serviceOnly = renderFunctionalModuleIndex(deriveNames('orders'), {
      [MODULE_SERVICE_ARTIFACTS]: ['orders'],
    });
    expect(serviceOnly).toContain(REGISTER_LINE);
    expect(serviceOnly).toContain('  void router;');
    const plain = renderFunctionalModuleIndex(deriveNames('orders'), { controller: ['orders'] });
    expect(plain).not.toContain('requestService');
    expect(plain).toContain("import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';");
    // A token for ANOTHER name in the family does not register this module's service.
    const foreign = renderFunctionalModuleIndex(deriveNames('orders'), {
      [MODULE_SERVICE_ARTIFACTS]: ['invoices'],
    });
    expect(foreign).not.toContain('services.register');
  });
});

describe('scanModuleArtifacts module-service family', () => {
  const cases = [
    {
      label: 'own token, services on',
      token: TOKEN,
      on: true,
      mode: 'functional',
      admitted: ['orders'],
    },
    { label: 'services off', token: TOKEN, on: false, mode: 'functional', admitted: undefined },
    {
      label: 'class-based project',
      token: TOKEN,
      on: true,
      mode: 'class-based',
      admitted: undefined,
    },
    {
      label: 'token missing its export',
      token: "export const OTHER = 'module.orders';\n",
      on: true,
      mode: 'functional',
      admitted: [],
    },
    { label: 'no token file', token: undefined, on: true, mode: 'functional', admitted: [] },
  ] as const;
  for (const c of cases) {
    it(c.label, async () => {
      const fs = createFakeFs(moduleSeed(FULL_STACK, c.token));
      const scan = await scanModuleArtifacts(fs, '/app', 'orders', c.mode, {
        moduleServices: c.on,
      });
      expect(scan.artifacts[MODULE_SERVICE_ARTIFACTS]).toEqual(c.admitted);
      expect(scan.adopted.some((a) => a.path.endsWith('.token.ts'))).toBe(false);
    });
  }

  it('admits only the module’s own token, never a second token file', async () => {
    const fs = createFakeFs({
      ...moduleSeed(FULL_STACK, TOKEN),
      '/app/src/modules/orders/audit.token.ts': "export const AUDIT = 'module.audit';\n",
    });
    const scan = await scanModuleArtifacts(fs, '/app', 'orders', 'functional', {
      moduleServices: true,
    });
    expect(scan.artifacts[MODULE_SERVICE_ARTIFACTS]).toEqual(['orders']);
  });
});

describe('every index writer keeps the registration', () => {
  it('setu sync renders it in a full-stack project and not elsewhere', async () => {
    const fullStack = harness(moduleSeed(FULL_STACK, TOKEN));
    expect(await fullStack.run(['sync']), fullStack.err.text()).toBe(0);
    expect(fullStack.fs.read('/app/src/modules/orders/index.ts')).toContain(REGISTER_LINE);
    // Idempotent: a second sync leaves it in place.
    expect(await fullStack.run(['sync'])).toBe(0);
    expect(fullStack.fs.read('/app/src/modules/orders/index.ts')).toContain(REGISTER_LINE);

    const rest = harness(moduleSeed('{}', TOKEN));
    expect(await rest.run(['sync']), rest.err.text()).toBe(0);
    expect(rest.fs.read('/app/src/modules/orders/index.ts')).not.toContain('services.register');
  });

  it('setu g controller --module regenerates the index with the line intact', async () => {
    const h = harness(moduleSeed(FULL_STACK, TOKEN));
    expect(await h.run(['sync'])).toBe(0);
    expect(await h.run(['generate', 'controller', 'refunds', '--module', 'orders'])).toBe(0);
    const index = h.fs.read('/app/src/modules/orders/index.ts');
    expect(index).toContain(REGISTER_LINE);
    expect(index).toContain('registerRefundsRoutes(router, services);');
    expect(index).toContain('registerOrdersRoutes(router, services);');
  });
});

import { expect, it } from 'vitest';
import { renderCheckFindings } from '../../src/diagnostics/render.ts';
import { diagnoseProject } from '../../src/diagnostics/diagnose.ts';
import { moduleActive, moduleSymbol } from '../../src/diagnostics/modules.ts';
import { runCli } from '../../src/cli.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';

it('returns typed scanner findings, legacy notices and raw generator inputs without writes', async () => {
  const fs = createFakeFs({
    '/app/src/controllers/bad.controller.ts': '',
    '/app/src/controllers/Bad.controller.ts': '',
    '/app/src/controllers/manual.controller.ts': 'export function registerManualRoutes() {}',
    '/app/src/modules/Bad/Bad.routes.ts': '',
    '/app/src/modules/missing/missing.routes.ts': '',
    '/app/src/routes/old.routes.ts': '',
    '/app/setu.config.ts': 'registerManualRoutes(app.router); registerGeneratedRoutes(app.router);',
  });
  const result = await diagnoseProject(fs, '/app', new Set());
  expect(result.findings.map((f) => f.kind)).toEqual([
    'module-rejected',
    'module-skipped',
    'artifact-skipped',
    'artifact-invalid',
    'manual-registration',
    'legacy-layout',
    'legacy-registrar',
  ]);
  expect(result.modules).toEqual([]);
  expect(fs.writes).toEqual([]);
});

it('opens the capped config only once across every family and module scan', async () => {
  const fs = createFakeFs({
    '/app/setu.config.ts': 'registerModules;',
    '/app/src/modules/orders/orders.routes.ts': 'export function registerOrdersRoutes() {}',
    '/app/src/modules/orders/index.ts': 'export function registerOrdersModule() {}',
  });
  let reads = 0;
  await diagnoseProject(
    {
      ...fs,
      readFile: (path) => {
        if (path === '/app/setu.config.ts') reads++;
        return fs.readFile(path);
      },
    },
    '/app',
    new Set(),
  );
  expect(reads).toBe(1);
});

it('diagnoses inactive and internally broken functional modules, including a targeted scan', async () => {
  const fs = createFakeFs({ '/app/package.json': '{}' });
  const run = (args: readonly string[]) =>
    runCli(args, { fs, cwd: '/app', now: () => 0, log: () => {}, error: () => {} });
  expect(await run(['generate', 'module', 'orders'])).toBe(0);
  await fs.writeFile('/app/src/modules/index.ts', new TextEncoder().encode(''));
  await fs.writeFile('/app/src/modules/orders/broken.controller.ts', new TextEncoder().encode(''));
  const result = await diagnoseProject(fs, '/app', new Set());
  expect(result.findings).toContainEqual({
    kind: 'module-inactive',
    module: 'orders',
    symbol: 'registerOrdersModule',
    mode: 'functional',
  });
  expect(result.findings).toContainEqual({
    kind: 'artifact-skipped',
    path: 'src/modules/orders/broken.controller.ts',
    missing: ['registerBrokenRoutes'],
  });
  expect(result.moduleArtifacts.get('orders')).toEqual({ controller: [], route: ['orders'] });
  const target = await diagnoseProject(fs, '/app', new Set(), { module: 'orders' });
  expect(target.artifacts).toEqual({ controller: [], route: ['orders'] });
  expect(target.findings.filter((f) => f.kind === 'artifact-skipped')).toHaveLength(1);
});

it('diagnoses class modules and preserves legacy migration names', async () => {
  const fs = createFakeFs({
    '/app/src/modules/orders/orders.controller.ts': 'export class OrdersController {}',
    '/app/src/modules/orders/orders.service.ts': 'export class OrdersService {}',
    '/app/src/modules/orders/orders.module.ts': 'export class OrdersModule {}',
    '/app/src/modules/legacy/legacy.controller.ts': 'export class LegacyController {}',
    '/app/src/modules/legacy/legacy.service.ts': 'export class LegacyService {}',
  });
  const result = await diagnoseProject(fs, '/app', new Set(['decorator-plugin']));
  expect(result.legacyModules).toEqual(['legacy']);
  expect(result.findings).toContainEqual({
    kind: 'module-inactive',
    module: 'orders',
    symbol: 'OrdersModule',
    mode: 'class-based',
  });
});

it('uses calls and MODULES elements rather than imports, exports or another array as activation', () => {
  for (const mode of ['functional', 'class-based'] as const) {
    const symbol = moduleSymbol('orders', mode);
    expect(moduleActive(`import { ${symbol} } from './orders/index.ts';`, symbol, mode)).toBe(
      false,
    );
    expect(moduleActive(`export const other = [${symbol}];`, symbol, mode)).toBe(false);
    expect(moduleActive('const label = `template`;', symbol, mode)).toBe(false);
    expect(
      moduleActive(
        mode === 'functional'
          ? `${symbol}(router, services);`
          : `export const MODULES = [${symbol}];`,
        symbol,
        mode,
      ),
    ).toBe(true);
  }
});

it('exposes the composing starter and its arms from the single bounded config snapshot', async () => {
  const fs = createFakeFs({
    '/app/setu.config.ts':
      "import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';",
  });
  let reads = 0;
  const result = await diagnoseProject(
    {
      ...fs,
      readFile: (path) => {
        if (path === '/app/setu.config.ts') reads++;
        return fs.readFile(path);
      },
    },
    '/app',
    new Set(),
  );
  expect(reads).toBe(1);
  expect(result.starter?.symbol).toBe('createFullStackAppFromConfig');
  expect(result.starter?.arms.get('queue-plugin')).toBe('queue');
});

it('renders owned functional config arms and keeps non-starter advice', () => {
  for (const [barrel, symbols, arm] of [
    ['src/events/index.ts', ['EVENT_HANDLERS'], 'events: { handlers: EVENT_HANDLERS }'],
    [
      'src/cqrs/index.ts',
      ['COMMAND_HANDLERS', 'QUERY_HANDLERS'],
      'cqrs: { commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS }',
    ],
  ] as const) {
    const finding = {
      kind: 'unwired',
      barrel,
      symbols,
      site: 'config',
      outcome: 'unwired',
    } as const;
    const lines: string[] = [];
    renderCheckFindings([{ ...finding, starter: 'createFullStackAppFromConfig' }], (line) =>
      lines.push(line),
    );
    expect(lines.join('\n')).toContain(arm);
    lines.length = 0;
    renderCheckFindings([finding, { ...finding, starter: 'createRestApp' }], (line) =>
      lines.push(line),
    );
    expect(lines.join('\n')).toContain('consume the barrel exports:');
    expect(lines.join('\n')).not.toContain(arm);
  }
});

import type { Finding } from '../../src/diagnostics/diagnose.ts';

/** One representative per stable diagnostic identity, including both wiring outcomes. */
export const CHECK_FINDINGS: readonly Finding[] = [
  {
    kind: 'artifact-skipped',
    path: 'src/controllers/bad.controller.ts',
    missing: ['registerBadRoutes'],
  },
  { kind: 'artifact-invalid', path: 'src/controllers/Bad.controller.ts' },
  {
    kind: 'barrel-drift',
    barrel: 'src/controllers/index.ts',
    unlisted: ['src/controllers/extra.controller.ts'],
    stale: ['src/controllers/gone.controller.ts'],
  },
  { kind: 'barrel-unreadable', barrel: 'src/controllers/index.ts', reason: 'not-a-file' },
  {
    kind: 'manual-registration',
    path: 'src/controllers/manual.controller.ts',
    symbol: 'registerManualRoutes',
    wiredIn: 'setu.config.ts',
  },
  {
    kind: 'unwired',
    barrel: 'src/controllers/index.ts',
    symbols: ['registerGeneratedRoutes'],
    site: 'config',
    outcome: 'unwired',
  },
  {
    kind: 'module-skipped',
    path: 'src/modules/orders',
    missing: 'registerOrdersModule',
    legacy: false,
    mode: 'functional',
  },
  { kind: 'module-rejected', path: 'src/modules/Bad' },
  { kind: 'module-inactive', module: 'orders', symbol: 'registerOrdersModule', mode: 'functional' },
  { kind: 'legacy-layout', files: ['old.routes.ts'] },
  { kind: 'check-config-invalid', path: '.setu-ts/check.json', entry: 'invalid JSON' },
  {
    kind: 'unwired',
    barrel: 'src/controllers/index.ts',
    symbols: ['registerGeneratedRoutes'],
    site: 'config',
    outcome: 'unclassifiable',
  },
  { kind: 'no-config', barrels: ['src/controllers/index.ts'] },
  { kind: 'legacy-registrar' },
  { kind: 'silence-unmatched', entry: '"setu.E003"' },
  { kind: 'config-unreadable', path: 'setu.config.ts', reason: 'not-a-file' },
  { kind: 'artifact-unreadable', path: 'src/controllers/huge.controller.ts', reason: 'too-large' },
];

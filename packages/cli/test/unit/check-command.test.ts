import { expect, it, vi } from 'vitest';
import * as diagnostics from '../../src/diagnostics/diagnose.ts';
import { runCli } from '../../src/cli.ts';
import { renderCheckFindings } from '../../src/diagnostics/render.ts';
import { findingId } from '../../src/diagnostics/ids.ts';
import { CHECK_FINDINGS } from '../fixtures/check-findings.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

function harness(seed: Readonly<Record<string, string>> = { '/app/package.json': '{}' }) {
  const fs = createFakeFs(seed);
  const err = createRecorder();
  const log = createRecorder();
  return {
    fs,
    err,
    log,
    run: (args: readonly string[]) =>
      runCli(args, { fs, cwd: '/app', now: () => 0, log: log.sink, error: err.sink }),
  };
}

it('V12-32 check accepts ordinary template and regex literals without W001', async () => {
  const h = harness();
  expect(await h.run(['new', 'rest', '--template', 'rest'])).toBe(0);
  const path = '/app/rest/setu.config.ts';
  await h.fs.writeFile(
    path,
    new TextEncoder().encode(
      h.fs.read(path) +
        '\nconst label = `ordinary ${1 + 2}`; const patterns = [/literal/]; void label; void patterns;',
    ),
  );
  expect(await h.run(['check', '--dir', '/app/rest']), h.err.text()).toBe(0);
  expect(h.err.text()).not.toContain('setu.W001');
});

it('H1 keeps a missing full-stack module token export at E001', async () => {
  const h = harness();
  expect(await h.run(['new', 'web', '--template', 'full-stack', '--runtime', 'node'])).toBe(0);
  expect(await h.run(['g', 'module', 'inventory', '--dir', '/app/web'])).toBe(0);
  await h.fs.writeFile(
    '/app/web/src/modules/inventory/inventory.token.ts',
    new TextEncoder().encode('const token = 1;'),
  );
  const start = h.err.lines.length;
  expect(await h.run(['check', '--dir', '/app/web'])).toBe(1);
  const output = h.err.lines.slice(start).join('\n');
  expect(output).toContain('setu.E001');
  expect(output).toContain('inventory.token.ts');
  expect(output).not.toContain('setu.W005');
});

it('M1 keeps REST check warning symbols local to its required wiring', async () => {
  const h = harness();
  expect(await h.run(['new', 'rest', '--template', 'rest', '--runtime', 'node'])).toBe(0);
  const path = '/app/rest/setu.config.ts';
  await h.fs.writeFile(
    path,
    new TextEncoder().encode(h.fs.read(path) + '\nconst label = globalThis;'),
  );
  const start = h.err.lines.length;
  expect(await h.run(['check', '--dir', '/app/rest'])).toBe(0);
  const warnings = h.err.lines.slice(start).filter((line) => line.includes('setu.W001'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('registerGeneratedRoutes');
  expect(warnings[0]).not.toContain('registerModules');
});

it('L1 prints the collapsed config warning for g module dry-run', async () => {
  const h = harness({
    '/app/package.json': '{}',
    '/app/setu.config.ts': 'const label = globalThis;',
  });
  const before = h.fs.writes.length;
  expect(await h.run(['g', 'module', 'orders', '--dry-run'])).toBe(0);
  expect(
    h.err.lines.filter((line) => line.includes('could not classify setu.config.ts')),
  ).toHaveLength(1);
  expect(h.fs.writes).toHaveLength(before);
});

it('X91-3 fails import-only config wiring and a registerModules value that is never called', async () => {
  for (const extra of ['', 'const pending = registerModules;']) {
    const h = harness({
      '/app/package.json': '{}',
      '/app/src/modules/index.ts': 'export function registerModules() {}',
      '/app/setu.config.ts': "import { registerModules } from './src/modules/index.ts';\n" + extra,
    });
    expect(await h.run(['check'])).toBe(1);
    expect(h.err.text()).toContain('setu.E006');
    if (extra === '') expect(h.err.text()).toContain('imports registerModules but never uses it');
    else expect(h.err.text()).toContain('does not call registerModules');
  }
});

it('X91-3 distinguishes unused imports from missing symbols in the same barrel finding', async () => {
  const h = harness({
    '/app/package.json': '{"dependencies":{"@setu-ts/decorator-plugin":"^0.11.0"}}',
    '/app/src/controllers/index.ts': '',
    '/app/setu.config.ts': "import { APP_CONTROLLERS } from './src/controllers/index.ts';",
  });
  expect(await h.run(['check'])).toBe(1);
  expect(h.err.text()).toContain(
    'imports APP_CONTROLLERS but never uses it; it does not use registerGeneratedRoutes outside imports',
  );
  expect(h.err.text()).not.toContain('imports APP_CONTROLLERS, registerGeneratedRoutes');
});

it('X91-3 2b detects a deleted module registrar call through check', async () => {
  const h = harness({ '/app/package.json': '{}' });
  expect(await h.run(['g', 'module', 'inventory'])).toBe(0);
  const path = '/app/src/modules/inventory/index.ts';
  await h.fs.writeFile(
    path,
    new TextEncoder().encode(
      h.fs.read(path).replace('registerInventoryRoutes(router, services);', ''),
    ),
  );
  expect(await h.run(['check'])).toBe(1);
  expect(h.err.text()).toContain('setu.E003');
  expect(h.err.text()).toContain(
    'imports registerInventoryRoutes but never registers it; run setu sync',
  );
});

it('V11-8 emits one located config warning and silences it by the config path', async () => {
  for (const [construct, label] of [
    ["import process from 'node:process';", 'import node:process'],
    ['const port = globalThis.PORT;', 'globalThis'],
    ['const port = env[key];', 'computed member access'],
  ]) {
    const seed = {
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/decorator-plugin': '^0.11.0' },
      }),
      '/app/src/controllers/index.ts': '',
      '/app/src/modules/index.ts': '',
      '/app/setu.config.ts': '// line one\n' + construct,
    };
    const h = harness(seed);
    expect(await h.run(['check'])).toBe(0);
    expect(h.err.lines).toHaveLength(1);
    expect(h.err.text()).toContain(
      'warning setu.W001: could not classify setu.config.ts at line 2',
    );
    expect(h.err.text()).toContain(label);
    expect(h.err.text()).not.toContain('does not reference');
    const silent = harness({
      ...seed,
      '/app/.setu-ts/check.json': JSON.stringify({
        silence: [{ id: 'setu.W001', path: 'setu.config.ts' }],
      }),
    });
    expect(await silent.run(['check'])).toBe(0);
    expect(silent.err.lines).toEqual([]);
    expect(silent.log.text()).toContain('1 silenced');
  }
});

it('X93-10 warns about an unlisted plain service but still refuses a missing registrar', async () => {
  const plain = harness({
    '/app/package.json': '{}',
    '/app/src/services/plain.service.ts': 'export function work() {}',
  });
  expect(await plain.run(['check'])).toBe(0);
  expect(plain.err.text()).toContain('setu.W005');
  expect(plain.err.text()).toContain(
    'not re-exported from src/services/index.ts: it does not export describePlain',
  );
  expect(plain.err.text()).not.toContain('nothing registers it');
  const route = harness({
    '/app/package.json': '{}',
    '/app/src/controllers/plain.controller.ts': 'export function work() {}',
  });
  expect(await route.run(['check'])).toBe(1);
  expect(route.err.text()).toContain('setu.E001');
});

it('applies the exit and summary policy to every finding identity through runCli', async () => {
  const base = await diagnostics.diagnoseProject(createFakeFs(), '/app', new Set());
  const spy = vi.spyOn(diagnostics, 'diagnoseProject');
  try {
    for (const finding of CHECK_FINDINGS) {
      spy.mockResolvedValue({ ...base, hasSeams: true, findings: [finding] });
      for (const strict of [false, true]) {
        const h = harness();
        const id = findingId(finding);
        const errors = id.startsWith('setu.E') || strict ? 1 : 0;
        const warnings = errors === 0 ? 1 : 0;
        expect(await h.run(strict ? ['check', '--strict'] : ['check']), id).toBe(errors);
        expect(h.err.lines[0]).toContain(`${id}:`);
        expect(h.log.lines.at(-1)).toBe(
          `setu check: ${errors} error(s), ${warnings} warning(s), 0 silenced in /app.`,
        );
        expect(h.fs.writes).toEqual([]);
      }
    }
  } finally {
    spy.mockRestore();
  }
});

it('renders each stable id with its severity and strict counts', () => {
  const expected = [
    'Skipped src/controllers/bad.controller.ts: it does not export registerBadRoutes, so it cannot be listed in the generated barrel and nothing registers it.',
    'Skipped src/controllers/Bad.controller.ts: its name is not a kebab-case identifier, so it cannot be listed in the barrel. Rename the file.',
    'src/controllers/index.ts has barrel drift: unlisted src/controllers/extra.controller.ts; stale src/controllers/gone.controller.ts.',
    'Cannot check src/controllers/index.ts: not-a-file.',
    'Skipped src/controllers/manual.controller.ts: registerManualRoutes is already registered by hand in setu.config.ts, so listing it in the generated barrel would register it twice.',
    'setu.config.ts does not reference registerGeneratedRoutes; consume the barrel exports: (src/controllers/index.ts)',
    'Skipped src/modules/orders: it is missing registerOrdersModule, so it cannot be listed in the registerModules activation barrel.',
    'Skipped src/modules/Bad: its name is not a kebab-case identifier, so it cannot be listed in the activation barrel. Rename the directory.',
    'Module "orders" is not activated in src/modules/index.ts, so its routes are unreachable; add:',
    'src/routes/ still holds 1 file(s): old.routes.ts.',
    'Invalid .setu-ts/check.json: invalid JSON. Nothing was silenced.',
    'could not classify setu.config.ts at line 1 (`globalThis`); setu check cannot tell whether it registers registerGeneratedRoutes',
    'No setu.config.ts; cannot check wiring for src/controllers/index.ts.',
    'setu.config.ts calls registerGeneratedRoutes(app.router) without the service registry.',
    'Silence entry "setu.E003" matched no finding.',
    'Cannot read setu.config.ts: not-a-file, so its wiring cannot be checked.',
    'Cannot read src/controllers/huge.controller.ts: too-large, so whether it is wired cannot be checked.',
    'This project has modules and also keeps controllers or services outside them: src/controllers/orders.controller.ts.',
    'src/modules/index.ts imports ./gone/index.ts, which does not exist.',
    'Two controller files share a base name and would bind one symbol: src/controllers/a/orders.controller.ts, src/controllers/b/orders.controller.ts.',
    'app/routes/_app/products._index.tsx:7 imports ~kernel/modules/products/products.service.ts by value, which would carry kernel code into the browser bundle.',
    'Cannot read the imports of app/routes/broken.tsx, so whether it imports kernel code by value cannot be checked.',
    'src/services/plain.service.ts is not re-exported from src/services/index.ts: it does not export describePlain.',
  ];
  for (const [index, finding] of CHECK_FINDINGS.entries()) {
    for (const strict of [false, true]) {
      const err = createRecorder();
      const id = findingId(finding);
      const error = id.startsWith('setu.E');
      expect(renderCheckFindings([finding], err.sink, strict)).toEqual({
        errors: error || strict ? 1 : 0,
        warnings: !error && !strict ? 1 : 0,
      });
      expect(err.lines[0]).toBe(`${error ? 'error' : 'warning'} ${id}: ${expected[index]}`);
      for (const remedy of err.lines.slice(1)) expect(remedy.startsWith('  ')).toBe(true);
    }
  }
});

it('checks without AGENTS.md or mutations, and prints the no-seams and summary lines', async () => {
  const h = harness();
  const remove = vi.spyOn(h.fs, 'rm');
  expect(await h.run(['check'])).toBe(0);
  expect(h.err.lines).toEqual([]);
  expect(h.log.lines).toEqual([
    'No CLI-owned seams in /app; nothing to check.',
    'setu check: 0 error(s), 0 warning(s), 0 silenced in /app.',
  ]);
  expect(h.fs.writes).toEqual([]);
  expect(h.fs.mkdirs).toEqual([]);
  expect(remove).not.toHaveBeenCalled();
});

it('fails on drift, silences exact barrel paths, and counts warnings under strict', async () => {
  const seed = {
    '/app/package.json': '{}',
    '/app/src/controllers/new.controller.ts': 'export function registerNewRoutes() {}',
    '/app/src/controllers/index.ts': '',
    '/app/setu.config.ts': 'const x = globalThis;',
  };
  const h = harness(seed);
  expect(await h.run(['check'])).toBe(1);
  expect(h.err.text()).toContain('error setu.E003:');
  expect(h.err.text()).toContain('new.controller.ts');
  const silenced = harness({
    ...seed,
    '/app/.setu-ts/check.json': JSON.stringify({ silence: ['setu.E003'] }),
  });
  expect(await silenced.run(['check'])).toBe(0);
  expect(silenced.log.lines.at(-1)).toBe(
    'setu check: 0 error(s), 1 warning(s), 1 silenced in /app.',
  );
  expect(await silenced.run(['check', '--strict'])).toBe(1);
  expect(silenced.log.lines.at(-1)).toBe(
    'setu check: 1 error(s), 0 warning(s), 1 silenced in /app.',
  );
});

it('refuses missing and unreadable projects and malformed workspaces', async () => {
  const none = harness({});
  expect(await none.run(['check'])).toBe(1);
  expect(none.err.text()).toBe(
    '/app holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.',
  );
  const bad = harness({ '/app/package.json': '{' });
  expect(await bad.run(['check'])).toBe(1);
  expect(bad.err.text()).toContain('Cannot read /app/package.json:');
  const workspace = harness({ '/app/setu.workspace.json': '{}' });
  expect(await workspace.run(['check'])).toBe(1);
  expect(workspace.err.text()).toContain('Cannot read /app/setu.workspace.json:');
});

it('walks members in manifest order, prefixes every line, takes the worst code, and stays local when directly addressed', async () => {
  const h = harness({
    '/app/setu.workspace.json': JSON.stringify({
      version: 1,
      runtime: 'node',
      basePort: 3000,
      transport: 'http',
      members: [
        { name: 'good', port: 3000 },
        { name: 'bad', port: 3001 },
        { name: 'missing', port: 3002 },
      ],
    }),
    '/app/apps/good/package.json': '{}',
    '/app/apps/bad/package.json': '{}',
    '/app/apps/bad/src/controllers/bad.controller.ts': '',
    '/app/.setu-ts/check.json': '{',
  });
  expect(await h.run(['check'])).toBe(1);
  expect(h.log.lines[0]).toBe('good: No CLI-owned seams in /app/apps/good; nothing to check.');
  expect(h.err.lines[0]).toContain('bad: error setu.E001:');
  expect(h.err.lines.at(-1)).toContain('missing: /app/apps/missing is not a readable project');
  expect(await h.run(['check', '--dir', 'apps/good'])).toBe(0);
});

it('refuses extra arguments and unsupported flags before any writes and documents both commands', async () => {
  for (const verb of ['check', 'sync']) {
    for (const extra of [['extra'], ['--json']]) {
      const h = harness();
      expect(await h.run([verb, ...extra])).toBe(2);
      expect(h.fs.writes).toEqual([]);
    }
    const h = harness();
    expect(await h.run([verb, '--help'])).toBe(0);
    expect(await h.run([verb, '-h'])).toBe(0);
    expect(h.log.text()).toContain(`Usage: setu ${verb}`);
  }
});

it('refuses a page value import as setu.E017 and lets .setu-ts/check.json silence it (M130 §3.7)', async () => {
  const page = 'app/routes/_app/products._index.tsx';
  const seed = {
    '/app/package.json': JSON.stringify({
      dependencies: { '@setu-ts/react-router-plugin': '^0.11.0' },
    }),
    [`/app/${page}`]:
      "import type { Product } from '~kernel/modules/products/products.types.ts';\n" +
      "import { PRODUCTS } from '~kernel/modules/products/products.token.ts';\n" +
      "import { productsService } from '~kernel/modules/products/products.service.ts';\n",
  };
  const refused = harness(seed);
  expect(await refused.run(['check'])).toBe(1);
  expect(refused.err.text()).toContain(
    `error setu.E017: ${page}:3 imports ~kernel/modules/products/products.service.ts by value`,
  );
  // The type import and the token import on lines 1 and 2 are allowed.
  expect(refused.err.text()).not.toContain(`${page}:1`);
  expect(refused.err.text()).not.toContain(`${page}:2`);

  const silenced = harness({
    ...seed,
    '/app/.setu-ts/check.json': JSON.stringify({ silence: ['setu.E017'] }),
  });
  expect(await silenced.run(['check'])).toBe(0);
  expect(silenced.log.lines.at(-1)).toBe(
    'setu check: 0 error(s), 0 warning(s), 1 silenced in /app.',
  );
});

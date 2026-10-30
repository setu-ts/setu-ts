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
    'setu.config.ts does not reference registerGeneratedRoutes; consume the barrel exports: (src/controllers/index.ts; config is unclassifiable)',
    'No setu.config.ts; cannot check wiring for src/controllers/index.ts.',
    'setu.config.ts calls registerGeneratedRoutes(app.router) without the service registry.',
    'Silence entry "setu.E003" matched no finding.',
    'Cannot read setu.config.ts: not-a-file, so its wiring cannot be checked.',
    'Cannot read src/controllers/huge.controller.ts: too-large, so whether it is wired cannot be checked.',
    'This project has modules and also keeps controllers or services outside them: src/controllers/orders.controller.ts.',
    'src/modules/index.ts imports ./gone/index.ts, which does not exist.',
    'Two controller files share a base name and would bind one symbol: src/controllers/a/orders.controller.ts, src/controllers/b/orders.controller.ts.',
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
    '/app/setu.config.ts': 'const x = `unclassifiable`;',
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

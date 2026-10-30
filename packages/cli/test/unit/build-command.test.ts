import { afterEach, expect, it, vi } from 'vitest';
import type { BuildOptions, BuildResult, Metafile } from 'esbuild';
import { bundleExternals, runBuildCommand } from '../../src/commands/build.ts';
import { runCli } from '../../src/cli.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import * as diagnostics from '../../src/diagnostics/diagnose.ts';
import { CHECK_FINDINGS } from '../fixtures/check-findings.ts';

afterEach(() => vi.restoreAllMocks());

function harness(seed: Record<string, string> = {}, meta: Metafile = { inputs: {}, outputs: {} }) {
  const fs = createFakeFs({ '/app/package.json': '{}', '/app/main.ts': '', ...seed });
  const log = createRecorder();
  const error = createRecorder();
  const bundle = vi.fn((options: BuildOptions): Promise<BuildResult> =>
    Promise.resolve({
      errors: [],
      warnings: [],
      metafile: meta,
      outputFiles: [
        {
          path: `${options.absWorkingDir}/dist/main.js`,
          contents: new TextEncoder().encode('compiled'),
          hash: '',
          text: 'compiled',
        },
      ],
      mangleCache: undefined,
    }),
  );
  const deps = { fs, cwd: '/app', log: log.sink, error: error.sink, bundle };
  return {
    fs,
    log,
    error,
    bundle,
    deps,
    run: (flags: Record<string, string | boolean> = {}) =>
      runBuildCommand({ positionals: [], flags }, deps),
  };
}

it('externalizes manifest dependencies including optional peers, except library names', () => {
  expect(
    bundleExternals(
      { dependencies: { '@local/lib': '*', prod: '*' }, devDependencies: { dev: '*' } },
      [
        {
          name: '@local/lib',
          dependencies: { third: '*' },
          optionalDependencies: { optional: '*' },
          peerDependencies: { peer: '*' },
        },
        { name: 42 },
      ],
    ),
  ).toEqual(['dev', 'optional', 'peer', 'prod', 'third']);
  expect(bundleExternals({})).toEqual([]);
});

it('runs help without a project; dispatcher rejects extras and unknown flags', async () => {
  const h = harness();
  for (const flag of ['help', 'h']) expect(await h.run({ [flag]: true })).toBe(0);
  expect(h.log.text()).toContain('--dry-run');
  for (const args of [
    ['build', 'extra'],
    ['build', '--typo'],
  ]) {
    expect(await runCli(args, { ...h.deps, now: () => 0 })).toBe(2);
  }
  expect(h.bundle).not.toHaveBeenCalled();
});

it('refuses workspace roots, nonprojects and malformed manifests before bundling', async () => {
  const h = harness({ '/ws/package.json': '{"workspaces":[]}', '/bad/package.json': '{' });
  expect(await h.run({ dir: '/ws' })).toBe(2);
  expect(h.error.text()).toContain('--dir apps/<member>');
  expect(await h.run({ dir: '/missing' })).toBe(1);
  expect(h.error.text()).toContain('holds no deno.json');
  expect(await h.run({ dir: '/bad' })).toBe(1);
  expect(h.error.text()).toContain('Cannot read');
  expect(h.bundle).not.toHaveBeenCalled();
});

it.each([
  [{ '/app/deno.json': '{}', '/app/package.json': '{}' }, 'deno task start'],
  [{ '/app/package.json': '{"scripts":{"start":"bun run main.ts"}}' }, 'bun run main.ts'],
  [{ '/app/wrangler.toml': '' }, 'wrangler deploy'],
])('refuses other runtime targets with their own command', async (seed, command) => {
  const h = harness(seed);
  expect(await h.run()).toBe(2);
  expect(h.error.text()).toContain(command);
  expect(h.bundle).not.toHaveBeenCalled();
});

it('plans main and migrations, never main.dev, without any mutation', async () => {
  const h = harness({
    '/app/src/migrations/run.ts': '',
    '/app/main.dev.ts': '',
    '/app/dist/old.js': '',
  });
  const remove = vi.spyOn(h.fs, 'rm');
  expect(await h.run({ 'dry-run': true })).toBe(0);
  expect(h.log.text()).toContain('src/migrations/run.ts -> dist/src/migrations/run.js');
  expect(h.log.text()).not.toContain('main.dev');
  expect(h.fs.writes).toEqual([]);
  expect(h.fs.mkdirs).toEqual([]);
  expect(remove).not.toHaveBeenCalled();
  expect(h.bundle).not.toHaveBeenCalled();
});

it('writes a bundle with the production options and removes old real dist first', async () => {
  const h = harness({ '/app/dist/old.js': '', '/app/src/migrations/run.ts': '' });
  const remove = vi.spyOn(h.fs, 'rm');
  expect(await h.run()).toBe(0);
  expect(remove).toHaveBeenCalledWith('/app/dist', { recursive: true });
  expect(h.bundle).toHaveBeenCalledWith(
    expect.objectContaining({
      absWorkingDir: '/app',
      entryPoints: ['main.ts', 'src/migrations/run.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: true,
      outdir: 'dist',
      outbase: '.',
      logLevel: 'silent',
      write: false,
      metafile: true,
    }),
  );
  expect(h.fs.read('/app/dist/main.js')).toBe('compiled');
  expect(h.log.text()).toContain('built dist/main.js');
  expect(h.log.text()).toContain('built dist/src/migrations/run.js');
});

it('gates error findings, but prints warnings and continues', async () => {
  const h = harness();
  const base = await diagnostics.diagnoseProject(h.fs, '/app', new Set());
  const spy = vi.spyOn(diagnostics, 'diagnoseProject');
  spy.mockResolvedValue({ ...base, findings: [CHECK_FINDINGS[2]!] });
  expect(await h.run()).toBe(1);
  expect(h.bundle).not.toHaveBeenCalled();
  spy.mockResolvedValue({ ...base, findings: [CHECK_FINDINGS[11]!] });
  expect(await h.run()).toBe(0);
  expect(h.error.text()).toContain('warning');
});

it('refuses a symlinked dist or a file without removing it', async () => {
  const h = harness({ '/app/dist/existing': '' });
  h.fs.realPath = (path) => Promise.resolve(path === '/app/dist' ? '/elsewhere' : path);
  const remove = vi.spyOn(h.fs, 'rm');
  expect(await h.run()).toBe(1);
  expect(h.error.text()).toContain('dist');
  expect(h.error.text()).toContain('symbolic link');
  expect(remove).not.toHaveBeenCalled();
  expect(await harness({ '/app/dist': 'file' }).run()).toBe(1);
});

it('reports esbuild locations, plain failures and filesystem failures', async () => {
  const h = harness();
  h.bundle.mockRejectedValueOnce({
    errors: [{ text: 'Cannot resolve bad', location: { file: 'main.ts', line: 3 } }],
  });
  expect(await h.run()).toBe(1);
  expect(h.error.text()).toContain('main.ts:3: Cannot resolve bad');
  h.bundle.mockRejectedValueOnce({ errors: [{ text: 'bad option' }] });
  expect(await h.run()).toBe(1);
  h.bundle.mockRejectedValueOnce('plain failure');
  expect(await h.run()).toBe(1);
  expect(h.error.text()).toContain('plain failure');
  const stat = h.fs.stat;
  h.fs.stat = (path) => {
    if (path === '/app/src/migrations/run.ts') return Promise.reject(new Error('EACCES'));
    return stat(path);
  };
  expect(await h.run()).toBe(1);
  expect(h.error.text()).toContain('EACCES');
});

it('rejects a runtime import of a devDependency before writing any output', async () => {
  const h = harness(
    {
      '/app/package.json': '{"devDependencies":{"dev-only":"*"}}',
      // The previous good build (M120 audit F5): a refusal must leave it in place.
      '/app/dist/main.js': 'previous build',
    },
    {
      inputs: {
        'main.ts': {
          bytes: 1,
          imports: [{ path: 'dev-only/subpath', kind: 'import-statement', external: true }],
        },
      },
      outputs: {},
    },
  );
  const remove = vi.spyOn(h.fs, 'rm');
  expect(await h.run()).toBe(1);
  expect(h.error.text()).toContain('main.ts: runtime import of devDependency "dev-only"');
  expect(h.fs.writes).toEqual([]);
  expect(remove).not.toHaveBeenCalled();
});

it('uses the importing library manifest for development imports and production exceptions', async () => {
  // M120 audit F7: only what `npm ci --omit=dev` installs counts as production. A
  // package in devDependencies AND peerDependencies is omitted there, so it is
  // refused like a plain devDependency; dependencies/optionalDependencies clear it.
  for (const [also, production] of [
    [undefined, false],
    ['peerDependencies', false],
    ['dependencies', true],
    ['optionalDependencies', true],
  ] as const) {
    const h = harness(
      {
        '/ws/setu.workspace.json': '{}',
        '/ws/apps/api/package.json': '{}',
        '/ws/apps/api/main.ts': '',
        '/ws/libs/shared/package.json': JSON.stringify({
          name: '@ws/shared',
          devDependencies: { '@third/peer': '*' },
          ...(also === undefined ? {} : { [also]: { '@third/peer': '*' } }),
        }),
        '/ws/libs/readme': 'ignored',
        '/ws/libs/empty/file': '',
      },
      {
        inputs: {
          '../../libs/shared/src/index.ts': {
            bytes: 1,
            imports: [{ path: '@third/peer/sub', kind: 'dynamic-import', external: true }],
          },
        },
        outputs: {},
      },
    );
    expect(await h.run({ dir: '/ws/apps/api' })).toBe(production ? 0 : 1);
    expect(h.bundle.mock.calls[0]?.[0].external).toEqual(['@third/peer']);
  }
});

it('accepts a workspace without libraries and ignores nonexternal imports', async () => {
  const h = harness(
    { '/ws/package.json': '{"workspaces":["apps/*"]}', '/ws/apps/api/package.json': '{}' },
    {
      inputs: {
        'main.ts': { bytes: 1, imports: [{ path: './local.ts', kind: 'import-statement' }] },
      },
      outputs: {},
    },
  );
  expect(await h.run({ dir: '/ws/apps/api' })).toBe(0);
});

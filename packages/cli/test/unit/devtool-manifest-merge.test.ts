import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runDevtoolCommand } from '../../src/commands/devtool.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from '../../src/workspace/manifest.ts';
import { LEGACY_DENO_RUN_ALL, workspaceProfile } from '../../src/workspace/runtime-profile.ts';

const CONFIG = 'export function createApp(\n' +
  '  _env?: Readonly<Record<string, unknown>>,\n' +
  '  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n' +
  '): IApplication {\n  return {} as IApplication;\n}\n';

const MEMBER_DENO_JSON = JSON.stringify({
  // Insertion order pinned on purpose: a merge that sorted the tasks map
  // (copying the `withDependency` precedent verbatim) would reorder a file
  // the CLI itself wrote and put every later regeneration at odds with it.
  tasks: {
    start: 'deno run --allow-net --allow-env main.ts',
    test: 'deno test -A',
    'db:push': 'deno run -A tools/push.ts',
  },
  imports: { '@setu-ts/common': 'jsr:@setu-ts/common@^0.7.0' },
  fmt: { lineWidth: 100 },
});

function harness(rootDev: string) {
  const fs = createFakeFs({
    [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: [{ name: 'orders', port: 3000 }],
    }),
    '/ws/deno.json': `${
      JSON.stringify(
        { workspace: ['./apps/*'], fmt: { lineWidth: 100 }, tasks: { dev: rootDev } },
        null,
        2,
      )
    }\n`,
    '/ws/apps/orders/deno.json': MEMBER_DENO_JSON,
    '/ws/apps/orders/setu.config.ts': CONFIG,
  });
  const log = createRecorder();
  return {
    fs,
    log,
    run: (argv: readonly string[]) =>
      runDevtoolCommand(parseArgs(argv), { fs, cwd: '/ws', log: log.sink, error: () => {} }),
  };
}

describe('the devtool manifest merge', () => {
  it('preserves every unrelated key and task, including a developer-owned one', async () => {
    const h = harness(LEGACY_DENO_RUN_ALL);
    expect(await h.run(['enable', 'orders'])).toBe(0);

    const member = JSON.parse(h.fs.read('/ws/apps/orders/deno.json')) as {
      tasks: Record<string, string>;
      imports: Record<string, string>;
      fmt: Record<string, unknown>;
    };
    expect(member.imports).toEqual({ '@setu-ts/common': 'jsr:@setu-ts/common@^0.7.0' });
    expect(member.fmt).toEqual({ lineWidth: 100 });
    expect(member.tasks['db:push']).toBe('deno run -A tools/push.ts');
    expect(member.tasks['start']).toBe('deno run --allow-net --allow-env main.ts');
    expect(member.tasks['test']).toBe('deno test -A');

    const root = JSON.parse(h.fs.read('/ws/deno.json')) as {
      fmt: Record<string, unknown>;
      tasks: Record<string, string>;
    };
    expect(root.fmt).toEqual({ lineWidth: 100 });
    expect(root.tasks['dev']).toBe(workspaceProfile('deno').runAll);
  });

  it('keeps the emitted task order instead of sorting it', async () => {
    const h = harness(LEGACY_DENO_RUN_ALL);
    expect(await h.run(['enable', 'orders'])).toBe(0);
    const member = JSON.parse(h.fs.read('/ws/apps/orders/deno.json')) as {
      tasks: Record<string, string>;
    };
    // start, test, the developer's own task, THEN the devtool's additions —
    // insertion order, not the sorted order `withDependency` produces.
    expect(Object.keys(member.tasks)).toEqual([
      'start',
      'test',
      'db:push',
      'dev',
      'check',
    ]);
  });

  it('is a no-op on the second run, not an error', async () => {
    const h = harness(LEGACY_DENO_RUN_ALL);
    expect(await h.run(['enable', 'orders'])).toBe(0);
    const afterFirst = h.fs.read('/ws/apps/orders/deno.json');
    const rootAfterFirst = h.fs.read('/ws/deno.json');
    const manifestAfterFirst = h.fs.read(`/ws/${WORKSPACE_MANIFEST}`);
    (h.fs.writes as string[]).length = 0;

    expect(await h.run(['enable', 'orders'])).toBe(0);
    expect(h.fs.read('/ws/apps/orders/deno.json')).toBe(afterFirst);
    expect(h.fs.read('/ws/deno.json')).toBe(rootAfterFirst);
    expect(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)).toBe(manifestAfterFirst);
    expect(h.log.text()).toContain('Enabled the devtool');
  });

  it('widens the root dev grant in place with --allow-net byte-identical', async () => {
    const h = harness(LEGACY_DENO_RUN_ALL);
    expect(await h.run(['enable', 'orders'])).toBe(0);
    const root = JSON.parse(h.fs.read('/ws/deno.json')) as { tasks: Record<string, string> };
    const dev = root.tasks['dev'];
    expect(dev).toBe(workspaceProfile('deno').runAll);
    // The network grant is untouched by the widening: the env grant is added
    // BESIDE it, never instead of it.
    expect(dev).toContain('--allow-read --allow-run --allow-net ');
    expect(dev).not.toContain('--allow-net=');
  });

  it('records the devtool port on an explicit --devtool-port', async () => {
    const h = harness(LEGACY_DENO_RUN_ALL);
    expect(await h.run(['enable', 'orders', '--devtool-port', '5500'])).toBe(0);
    const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: { devtoolPort?: number }[];
    };
    expect(manifest.members[0].devtoolPort).toBe(5500);
    // The same number is what the generated entry binds.
    expect(h.fs.read('/ws/apps/orders/main.dev.ts')).toContain('port: 5500,');
  });
});

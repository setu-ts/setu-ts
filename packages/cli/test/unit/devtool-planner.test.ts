import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { runAppCommand } from '../../src/commands/app.ts';
import { runDevtoolCommand } from '../../src/commands/devtool.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceMember,
} from '../../src/workspace/manifest.ts';
import { LEGACY_DENO_RUN_ALL } from '../../src/workspace/runtime-profile.ts';

/** The emitted config module a current CLI writes — the signature `enable` accepts. */
const CONFIG = `import { createApplication, type KernelDiagnosticsOptions } from '@setu-ts/kernel';
import type { IApplication, IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IApplication {
  const app = createApplication({
    plugins: [RuntimePlugin(), ...(devtool?.plugins ?? [])],
    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
  });
  return app;
}
`;

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  runNew(argv: readonly string[], cwd?: string): Promise<number>;
  runApp(argv: readonly string[]): Promise<number>;
  runDevtool(argv: readonly string[], cwd?: string): Promise<number>;
}

function harnessOver(fs: FakeFs): Harness {
  const out = createRecorder();
  const err = createRecorder();
  const deps = { fs, log: out.sink, error: err.sink };
  return {
    fs,
    out,
    err,
    runNew: (argv, cwd = '/ws') => runNewCommand(parseArgs(argv), { ...deps, cwd }),
    runApp: (argv) => runAppCommand(parseArgs(argv), { ...deps, dir: '/ws' }),
    runDevtool: (argv, cwd = '/ws') => runDevtoolCommand(parseArgs(argv), { ...deps, cwd }),
  };
}

/**
 * Builds an in-memory workspace with one member scaffolded as `generate app`
 * would leave it: a manifest, a root `deno.json` carrying the pre-M98c dev
 * task, and the member's own project files.
 */
function workspaceHarness(members: readonly WorkspaceMember[], withMemberFiles = true): Harness {
  const seed: Record<string, string> = {
    [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members,
    }),
    '/ws/deno.json': `${
      JSON.stringify(
        { workspace: ['./apps/*'], tasks: { dev: LEGACY_DENO_RUN_ALL } },
        null,
        2,
      )
    }\n`,
  };
  if (withMemberFiles) {
    seed['/ws/apps/orders/deno.json'] = `${
      JSON.stringify(
        { tasks: { start: 'deno run --allow-net --allow-env main.ts', test: 'deno test -A' } },
        null,
        2,
      )
    }\n`;
    seed['/ws/apps/orders/setu.config.ts'] = CONFIG;
  }
  return harnessOver(createFakeFs(seed));
}

function standaloneHarness(): Harness {
  return harnessOver(createFakeFs({
    '/ws/shop/deno.json': `${
      JSON.stringify(
        { tasks: { start: 'deno run --allow-net --allow-env main.ts', test: 'deno test -A' } },
        null,
        2,
      )
    }\n`,
    '/ws/shop/setu.config.ts': CONFIG,
  }));
}

describe('the one devtool planner', () => {
  it('emits byte-identical files from `generate app --devtool` and `devtool enable`', async () => {
    // Same member, same inputs: the flag path and the standalone command must
    // not be able to drift.
    const member: WorkspaceMember = { name: 'orders', port: 3000 };

    // The flag path CREATES the member; the workspace it runs in is empty and
    // carries none of the member's files.
    const created = workspaceHarness([], false);
    const createdCode = await created.runApp(['app', 'orders', '--devtool']);
    expect(createdCode, created.err.text()).toBe(0);
    const viaFlag = created.fs.read('/ws/apps/orders/main.dev.ts');
    const flagTasks = JSON.parse(created.fs.read('/ws/apps/orders/deno.json')) as {
      tasks: Record<string, string>;
    };

    const enabled = workspaceHarness([member]);
    const enabledCode = await enabled.runDevtool(['enable', 'orders']);
    expect(enabledCode, enabled.err.text()).toBe(0);
    const viaCommand = enabled.fs.read('/ws/apps/orders/main.dev.ts');
    const commandTasks = JSON.parse(enabled.fs.read('/ws/apps/orders/deno.json')) as {
      tasks: Record<string, string>;
    };

    expect(viaCommand).toBe(viaFlag);
    expect(commandTasks.tasks['dev']).toBe(flagTasks.tasks['dev']);
    expect(commandTasks.tasks['check']).toBe(flagTasks.tasks['check']);
    // The port each records is the same datum the launcher reads.
    const manifest = JSON.parse(enabled.fs.read('/ws/setu.workspace.json')) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].devtoolPort).toBe(3001);
  });

  it('emits byte-identical files from `new --devtool` and `devtool enable` standalone', async () => {
    // The flag path CREATES the project; the enable leg meets the same files
    // already on disk.
    const created = harnessOver(createFakeFs());
    const createdCode = await created.runNew(
      ['shop', '--devtool', '--devtool-port', '4919'],
      '/ws',
    );
    expect(createdCode, created.err.text()).toBe(0);
    const viaFlag = created.fs.read('/ws/shop/main.dev.ts');
    const flagTasks = JSON.parse(created.fs.read('/ws/shop/deno.json')) as {
      tasks: Record<string, string>;
    };

    const enabled = standaloneHarness();
    const enabledCode = await enabled.runDevtool(['enable', '--devtool-port', '4919'], '/ws/shop');
    expect(enabledCode, enabled.err.text()).toBe(0);
    const viaCommand = enabled.fs.read('/ws/shop/main.dev.ts');
    const commandTasks = JSON.parse(enabled.fs.read('/ws/shop/deno.json')) as {
      tasks: Record<string, string>;
    };

    expect(viaCommand).toBe(viaFlag);
    expect(commandTasks.tasks['dev']).toBe(flagTasks.tasks['dev']);
    expect(commandTasks.tasks['check']).toBe(flagTasks.tasks['check']);
  });
});

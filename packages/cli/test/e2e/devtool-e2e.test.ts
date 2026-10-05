/**
 * The end-to-end gate for the devtool opt-in.
 *
 * Emitted text passing review proves nothing about a generated project (the
 * M58 and M63 lesson), so this file scaffolds one, repoints it at THIS
 * workspace, type-checks it through its own `check` task, BOOTS the
 * development entry under the credentials the launcher would supply, and reads
 * a snapshot and an event batch through `createDiagnosticsClient` — the
 * reviewed M98b client, so the gate drives the real protocol rather than a
 * stand-in. A probe that only inspects emitted text would verify the renderer,
 * not the feature.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  unusedPort,
  useWorkspacePackages,
  workspaceEntrypoint,
} from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-devtool-e2e-' });
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true }).catch(() => {});
});

/** Runs the CLI with the temp root as its working directory. */
async function run(args: readonly string[], cwd = root): Promise<number> {
  return await runCli(args, {
    fs,
    cwd,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

/** Runs a deno subcommand inside a project and reports code and output. */
async function denoRun(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; output: string; stdout: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd,
    env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    output: `${decoder.decode(stdout)}${decoder.decode(stderr)}`,
  };
}

/** A fresh valid credential pair, shaped exactly as the launcher would hand it over. */
function credentials(): { sessionId: string; sessionKey: string; env: Record<string, string> } {
  const sessionId = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const sessionKey = Array.from(keyBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    sessionId,
    sessionKey,
    env: { SETU_DEVTOOL_SESSION_ID: sessionId, SETU_DEVTOOL_SESSION_KEY: sessionKey },
  };
}

/**
 * The driver planted in the scaffolded project: pairs, reads a snapshot,
 * generates a request so an event exists, reads the batch, prints JSON.
 *
 * It imports `@setu-ts/diagnostics-plugin` through the project's own import
 * map — repointed at this workspace — so the client under test is the same
 * source the project's connector is checked against.
 */
const DRIVER = `
import { createDiagnosticsClient } from '@setu-ts/diagnostics-plugin';
const [devtoolPort, appPort, sessionId, keyHex] = Deno.args;
const sessionKey = Uint8Array.from(keyHex.match(/../g).map((byte) => parseInt(byte, 16)));
const client = createDiagnosticsClient({
  endpoint: \`http://127.0.0.1:\${devtoolPort}\`,
  sessionId,
  sessionKey,
  subtle: crypto.subtle,
  fetch,
  timing: { setTimeout, clearTimeout },
});
const snapshot = await client.snapshot();
await fetch(\`http://127.0.0.1:\${appPort}/\`);
const batch = await client.read(0, 16);
console.log(JSON.stringify({
  instanceId: snapshot.instanceId,
  state: snapshot.state,
  events: batch.events.length,
  routeNodes: snapshot.nodes.length,
}));
client.close();
`;

interface Booted {
  stop(): Promise<void>;
  output(): Promise<string>;
}

/**
 * Boots the generated development entry under its own task, waiting until the
 * application port answers.
 *
 * The env is passed explicitly — the launcher's own mechanism — and the boot
 * deliberately does not blanket-grant permissions: a grant the task forgot is
 * unobservable under `-A`.
 */
async function bootDev(
  project: string,
  appPort: number,
  env: Record<string, string>,
): Promise<Booted> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ['task', 'dev'],
    cwd: project,
    env: { PORT: String(appPort), ...env },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let exited = false;
  const exiting = child.status.then(() => {
    exited = true;
  });
  const outputOf = async (): Promise<string> => {
    const { stdout, stderr } = await child.output();
    const decoder = new TextDecoder();
    return `${decoder.decode(stderr)}${decoder.decode(stdout)}`;
  };
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    await Promise.race([
      exiting,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    // A child that already exited (a refusal, or a crash the check task
    // cannot see) must be reported with its output, not polled.
    if (exited) throw new Error(`the development entry exited early: ${await outputOf()}`);
    const answered = await fetch(`http://127.0.0.1:${appPort}/`)
      .then((response) => response.ok)
      .catch(() => false);
    if (answered) {
      return {
        stop: async () => {
          if (exited) return;
          try {
            child.kill('SIGTERM');
          } catch {
            // Already gone.
          }
          await child.status;
        },
        output: outputOf,
      };
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  throw new Error(`the development entry never answered: ${await outputOf()}`);
}

describe('a scaffolded devtool project, driven end to end', () => {
  it('formats both standalone and workspace development entries without a repair', async () => {
    expect(await run(['new', 'formatted', '--devtool'])).toBe(0);
    const standalone = await denoRun(`${root}/formatted`, ['fmt', '--check']);
    expect(standalone.output).not.toContain('not formatted');
    expect(standalone.code).toBe(0);
    expect(await run(['new', 'workspace', '--workspace'])).toBe(0);
    expect(await run(['generate', 'app', 'orders', '--devtool'], `${root}/workspace`)).toBe(0);
    const member = await denoRun(`${root}/workspace/apps/orders`, ['fmt', '--check']);
    expect(member.output).not.toContain('not formatted');
    expect(member.code).toBe(0);
  });
  it('stops and exits when a hand-edited factory drops either part of the composition', async () => {
    for (const dropped of ['plugins', 'diagnostics']) {
      const appPort = unusedPort();
      expect(await run(['new', dropped, '--devtool', '--devtool-port', String(unusedPort())])).toBe(
        0,
      );
      const project = `${root}/${dropped}`;
      await useWorkspacePackages(project);
      const path = `${project}/setu.config.ts`;
      const source = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        source.replace(
          dropped === 'plugins'
            ? '...(devtool?.plugins ?? [])'
            : '...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {})',
          '...[]',
        ),
      );
      const result = await denoRun(project, ['task', 'dev'], {
        ...credentials().env,
        PORT: String(appPort),
      });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(
        dropped === 'plugins'
          ? 'did not pass the devtool composition'
          : 'not created with kernel diagnostics enabled',
      );
      expect(await fetch(`http://127.0.0.1:${appPort}/`).then(() => true).catch(() => false)).toBe(
        false,
      );
    }
  });

  it('boots a reallocated workspace entry and answers the signed client at its new port', async () => {
    const appPort = unusedPort();
    const oldPort = unusedPort();
    const newPort = unusedPort();
    expect(await run(['new', 'acme', '--workspace', '--port', String(appPort)])).toBe(0);
    const workspace = `${root}/acme`;
    expect(
      await run([
        'generate',
        'app',
        'orders',
        '--devtool',
        '--devtool-port',
        String(oldPort),
        '--dir',
        workspace,
      ]),
    ).toBe(0);
    const manifestPath = `${workspace}/setu.workspace.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.devtoolBasePort = newPort;
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    expect(await run(['workspace', 'ports', '--reallocate', '--dir', workspace])).toBe(0);
    const project = `${workspace}/apps/orders`;
    expect(await Deno.readTextFile(`${project}/main.dev.ts`)).toContain(`port: ${newPort},`);
    expect(await Deno.readTextFile(`${workspace}/.dockerignore`)).toContain('apps/*/main.dev.ts');
    await useWorkspacePackages(project);
    const pair = credentials();
    const booted = await bootDev(project, appPort, pair.env);
    try {
      await Deno.writeTextFile(`${project}/driver.ts`, DRIVER);
      const result = await denoRun(project, [
        'run',
        '--allow-net',
        'driver.ts',
        String(newPort),
        String(appPort),
        pair.sessionId,
        pair.sessionKey,
      ]);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.output.trim().split('\n').pop()!).instanceId).not.toBeNull();
      expect(
        await fetch(`http://127.0.0.1:${oldPort}/v1/status`).then(() => true).catch(() => false),
      ).toBe(false);
    } finally {
      await booted.stop();
    }
  });
  it(
    'type-checks, boots with credentials, and answers the real client',
    { timeout: 240_000 },
    async () => {
      const devtoolPort = unusedPort();
      const appPort = unusedPort();
      expect(await run(['new', 'shop', '--devtool', '--devtool-port', String(devtoolPort)])).toBe(
        0,
      );
      const project = `${root}/shop`;
      await useWorkspacePackages(project);

      // The devtool opt-in's own check task: main.ts, setu.config.ts AND
      // main.dev.ts — the arity mismatch the pre-letter factories hid would be a
      // TS2554 exactly here.
      const checked = await denoRun(project, ['task', 'check']);
      expect(checked.code, checked.output).toBe(0);

      const credentials_ = credentials();
      const booted = await bootDev(project, appPort, credentials_.env);
      try {
        await Deno.writeTextFile(`${project}/driver.ts`, DRIVER);
        const driven = await denoRun(project, [
          'run',
          '--allow-net',
          'driver.ts',
          String(devtoolPort),
          String(appPort),
          credentials_.sessionId,
          credentials_.sessionKey,
        ]);
        expect(driven.code, driven.output).toBe(0);
        const report = JSON.parse(driven.stdout.trim().split('\n').pop()!) as {
          instanceId: string | null;
          events: number;
        };
        expect(report.instanceId).not.toBeNull();
        expect(report.events).toBeGreaterThanOrEqual(1);
      } finally {
        await booted.stop();
      }
    },
  );

  it('refuses to boot without credentials, with a named message and no connector', async () => {
    const devtoolPort = unusedPort();
    const appPort = unusedPort();
    expect(await run(['new', 'shop', '--devtool', '--devtool-port', String(devtoolPort)])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);

    const refused = await denoRun(project, ['task', 'dev'], { PORT: String(appPort) });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('SETU_DEVTOOL_SESSION_ID is absent or malformed');
    // Nothing ever bound: the refusal happens before the connector starts.
    expect(refused.output).not.toContain('Listening on');
  });

  it('enables the devtool on a project carrying the pre-M98c factory, refusing first', async () => {
    const devtoolPort = unusedPort();
    const appPort = unusedPort();
    expect(await run(['new', 'legacy'])).toBe(0);
    const project = `${root}/legacy`;

    // Rewrite the config to the shape every pre-M98c project carries: a
    // zero-parameter factory and NO devtool weave in the body — the shape
    // `deno run` silently discards arguments against.
    const configPath = `${project}/setu.config.ts`;
    const config = await Deno.readTextFile(configPath);
    await Deno.writeTextFile(
      configPath,
      config
        .replace(
          "import type { IPlugin } from '@setu-ts/common';",
          "import type { IApplication, IPlugin } from '@setu-ts/common';",
        )
        .replace(/type IKernelApplication,\s*/g, '')
        .replace(
          /export function createApp\([\s\S]*?\): IKernelApplication \{/,
          'export function createApp(): IApplication {',
        )
        .replace('      ...(devtool?.plugins ?? []),\n', '')
        // The weave's comment travels with the spread it explains; removing
        // both leaves the exact options block a pre-M98c factory closed with.
        .replace(
          /\n {4}\/\/ Kernel diagnostics reach the CONSTRUCTOR[\s\S]*?registered onto a finished application\.\n/,
          '\n',
        )
        .replace(
          '    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),\n',
          '',
        ),
    );
    // A developer-owned task and an unrelated top-level key, asserted intact
    // below — the merge case, exercised on the same project.
    const manifestPath = `${project}/deno.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as Record<string, unknown>;
    manifest['//devtool-note'] = 'hand-written key';
    (manifest['tasks'] as Record<string, string>)['db:push'] = 'deno run -A tools/push.ts';
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // The refusal: named, quoting the fix, writing NOTHING.
    const refused = await run(['devtool', 'enable', '--dir', project]);
    expect(refused).toBe(1);
    expect(
      await Deno.readTextFile(`${project}/setu.config.ts`),
    ).toContain('export function createApp(): IApplication {');
    expect(
      (JSON.parse(await Deno.readTextFile(manifestPath)) as { tasks: Record<string, string> })
        .tasks['dev'],
    )
      .toBeUndefined();

    const signatureOnly = (await Deno.readTextFile(configPath)).replace(
      'export function createApp(): IApplication {',
      'export function createApp(_env?: Readonly<Record<string, unknown>>, devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }): IApplication {',
    );
    await Deno.writeTextFile(configPath, signatureOnly);
    expect(await run(['devtool', 'enable', '--dir', project])).toBe(1);
    await Deno.writeTextFile(
      configPath,
      signatureOnly.replace(
        'export function createApp(_env?: Readonly<Record<string, unknown>>, devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }): IApplication {',
        'export function createApp(): IApplication {',
      ),
    );

    // Apply the edit the refusal names — the factory takes the devtool
    // composition as its SECOND parameter and the composition reaches the
    // constructor — exactly what a developer follows it with.
    await Deno.writeTextFile(
      configPath,
      (await Deno.readTextFile(configPath))
        .replace(
          "import { createApplication } from '@setu-ts/kernel';",
          "import { createApplication, type KernelDiagnosticsOptions } from '@setu-ts/kernel';",
        )
        .replace(
          "import type { IApplication } from '@setu-ts/common';",
          "import type { IPlugin } from '@setu-ts/common';",
        )
        .replace(
          "import type { IApplication, IPlugin } from '@setu-ts/common';",
          "import type { IPlugin } from '@setu-ts/common';",
        )
        .replace(
          'type KernelDiagnosticsOptions',
          'type IKernelApplication, type KernelDiagnosticsOptions',
        )
        .replace(
          'export function createApp(): IApplication {',
          'export function createApp(\n' +
            '  _env?: Readonly<Record<string, unknown>>,\n' +
            '  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n' +
            '): IKernelApplication {',
        )
        .replace(
          '      RuntimePlugin(),\n',
          '      RuntimePlugin(),\n      ...(devtool?.plugins ?? []),\n',
        )
        .replace(
          '    ],\n  });',
          '    ],\n' +
            '    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),\n' +
            '  });',
        ),
    );
    expect(
      await run(['devtool', 'enable', '--dir', project, '--devtool-port', String(devtoolPort)]),
    )
      .toBe(0);
    const after = JSON.parse(await Deno.readTextFile(manifestPath)) as {
      tasks: Record<string, string>;
      imports: Record<string, string>;
      '//devtool-note'?: string;
    };
    expect(after['//devtool-note']).toBe('hand-written key');
    expect(after.tasks['db:push']).toBe('deno run -A tools/push.ts');
    expect(after.tasks['dev']).toContain('main.dev.ts');
    expect(after.tasks['dev']).not.toBe(after.tasks['start']);
    // The enable flow added the pin the entry resolves through — the exact
    // specifier the create-time paths write, not a registry fall-through.
    expect(after.imports['@setu-ts/diagnostics-plugin']).toBe(
      'jsr:@setu-ts/diagnostics-plugin@^0.8.0',
    );
    // Repoint the pin at this workspace too, so the check and the boot below
    // measure the workspace source rather than a published JSR snapshot —
    // the same repointing `useWorkspacePackages` performs, applied to the key
    // the enable flow just added.
    const repointed = { ...after };
    repointed.imports['@setu-ts/diagnostics-plugin'] = workspaceEntrypoint('diagnostics-plugin');
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(repointed, null, 2)}\n`);

    await useWorkspacePackages(project);

    // The project type-checks THROUGH the new check task — the arity mismatch
    // would be TS2554 here — and serves a snapshot.
    const checked = await denoRun(project, ['task', 'check']);
    expect(checked.code, checked.output).toBe(0);
    const tested = await denoRun(project, ['task', 'test']);
    expect(tested.code, tested.output).toBe(0);
    expect(tested.output).toContain('1 passed');

    const credentials_ = credentials();
    const booted = await bootDev(project, appPort, credentials_.env);
    try {
      await Deno.writeTextFile(`${project}/driver.ts`, DRIVER);
      const driven = await denoRun(project, [
        'run',
        '--allow-net',
        'driver.ts',
        String(devtoolPort),
        String(appPort),
        credentials_.sessionId,
        credentials_.sessionKey,
      ]);
      expect(driven.code, driven.output).toBe(0);
      const report = JSON.parse(driven.stdout.trim().split('\n').pop()!) as {
        instanceId: string | null;
      };
      expect(report.instanceId).not.toBeNull();
    } finally {
      await booted.stop();
    }
  });
});

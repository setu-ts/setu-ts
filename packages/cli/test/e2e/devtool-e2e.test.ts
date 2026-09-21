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
import { unusedPort, useWorkspacePackages } from '../fixtures/generated-project.ts';

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
): Promise<{ code: number; output: string }> {
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
  return { code, output: `${decoder.decode(stdout)}${decoder.decode(stderr)}` };
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
        const report = JSON.parse(driven.output.trim().split('\n').pop()!) as {
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
    await useWorkspacePackages(project);

    // Rewrite the config to the shape every pre-M98c project carries: a
    // zero-parameter factory and NO devtool weave in the body — the shape
    // `deno run` silently discards arguments against.
    const configPath = `${project}/setu.config.ts`;
    const config = await Deno.readTextFile(configPath);
    await Deno.writeTextFile(
      configPath,
      config
        .replace(
          /export function createApp\([\s\S]*?\): IApplication \{/,
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
          "import type { IApplication, IPlugin } from '@setu-ts/common';",
        )
        .replace(
          'export function createApp(): IApplication {',
          'export function createApp(\n' +
            '  _env?: Readonly<Record<string, unknown>>,\n' +
            '  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n' +
            '): IApplication {',
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
      '//devtool-note'?: string;
    };
    expect(after['//devtool-note']).toBe('hand-written key');
    expect(after.tasks['db:push']).toBe('deno run -A tools/push.ts');
    expect(after.tasks['dev']).toContain('main.dev.ts');
    expect(after.tasks['dev']).not.toBe(after.tasks['start']);

    // The project type-checks THROUGH the new check task — the arity mismatch
    // would be TS2554 here — and serves a snapshot.
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
      const report = JSON.parse(driven.output.trim().split('\n').pop()!) as {
        instanceId: string | null;
      };
      expect(report.instanceId).not.toBeNull();
    } finally {
      await booted.stop();
    }
  });
});

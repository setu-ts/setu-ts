import {
  denoBinary,
  run as runProcess,
  spawnProcess,
  tempDir,
} from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type {
  CacheDiagnosticsResponse,
  HealthDiagnosticsSnapshot,
  IFileSystem,
} from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  unusedPort,
  useWorkspacePackages,
  workspaceEntrypoint,
} from '../fixtures/generated-project.ts';
import { VERSION } from '../../src/version.ts';
import {
  npmInstall,
  npmRun,
  type RegistryOverlay,
  startOverlay,
} from '../fixtures/node-project.ts';
import { tmpdir } from 'node:os';
import { eventually, launchGroup, liveProcesses } from '../fixtures/process-group.ts';
import { createDiagnosticsClient } from '../../../diagnostics-plugin/src/index.ts';
import { createConnection } from 'node:net';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

let root = '';
let overlay: RegistryOverlay;

beforeAll(async () => {
  overlay = await startOverlay();
}, 900_000);
afterAll(async () => {
  await overlay?.close();
});

beforeEach(async () => {
  root = await tempDir({ dir: tmpdir(), prefix: 'setu-devtool-e2e-' });
});

afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
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
  const command = () =>
    runProcess(denoBinary(), {
      args: [...args],
      cwd,
      env: { NPM_CONFIG_REGISTRY: overlay.url, ...env },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    });
  const { code, stdout, stderr } = await command();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    output: `${decoder.decode(stdout)}${decoder.decode(stderr)}`,
  };
}

/** A fresh valid credential pair, shaped exactly as the launcher would hand it over. */
function credentials(): { sessionId: string; sessionKey: string; env: Record<string, string> } {
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
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

/** The reviewed client, with a new launcher pair for every Node boot. */
function nodeClient(port: number, pair: ReturnType<typeof credentials>) {
  return createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${port}`,
    sessionId: pair.sessionId,
    sessionKey: Uint8Array.from(pair.sessionKey.match(/../g)!, (byte) => Number.parseInt(byte, 16)),
    subtle: crypto.subtle,
    fetch,
    timing: { setTimeout, clearTimeout },
  });
}

/** Cancels the response body while polling an application's actual HTTP port. */
async function nodeReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Checks the TCP port itself, so a protocol refusal still counts as a bound socket. */
function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

describe('a scaffolded Node devtool project, driven end to end', () => {
  it(
    'checks, boots, snapshots, reads events, renews, stops its process tree and excludes the connector from the production bundle',
    { timeout: 300_000 },
    async () => {
      const port = await unusedPort();
      const appPort = await unusedPort();
      expect(await run(['new', 'node-shop', '--devtool', '--devtool-port', String(port)])).toBe(0);
      const project = `${root}/node-shop`;
      // The same registry fixture as the Deno cases serves packages packed from
      // this exact worktree, including its current CLI, runtime and connector.
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      for (const script of ['format:check', 'lint', 'check']) {
        const result = await npmRun(project, script);
        expect(result.code, result.output).toBe(0);
      }
      const pair = credentials();
      const launched = launchGroup('npm', ['run', 'dev'], project, {
        ...pair.env,
        SETU_DEVTOOL_MEMBER: '',
        PORT: String(appPort),
      });
      const client = nodeClient(port, pair);
      try {
        await eventually(
          () => nodeReady(appPort),
          'The generated Node development entry did not become ready',
        );
        expect((await client.snapshot()).state).toBe('running');
        expect(await nodeReady(appPort)).toBe(true);
        const batch = await client.read(0, 16);
        expect(batch.events.length).toBeGreaterThan(0);
        const renewed = await client.renew();
        expect(renewed.renewal).not.toBeNull();
        expect(renewed.expiresInMs).toBeGreaterThan(0);
        expect(launched.output().includes(pair.sessionId)).toBe(false);
        expect(launched.output().includes(pair.sessionKey)).toBe(false);
      } finally {
        client.close();
        await launched.stop();
      }
      expect(await acceptsConnection(port)).toBe(false);
      expect(await acceptsConnection(appPort)).toBe(false);
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      const bundle = await nodeFs.readFile(`${project}/dist/main.js`, 'utf8');
      expect(bundle).not.toContain('diagnostics-plugin');
      expect(bundle).not.toContain('SETU_DEVTOOL_');
    },
  );

  it(
    'pairs only with workspace member a and blanks both credentials in member b node processes',
    { timeout: 300_000 },
    async () => {
      const appPort = await unusedPort();
      const siblingPort = await unusedPort();
      const port = await unusedPort();
      expect(await run(['new', 'node-workspace', '--workspace', '--port', String(appPort)])).toBe(
        0,
      );
      const project = `${root}/node-workspace`;
      expect(
        await run(
          [
            'generate',
            'app',
            'a',
            '--port',
            String(appPort),
            '--devtool',
            '--devtool-port',
            String(port),
          ],
          project,
        ),
      ).toBe(0);
      expect(await run(['generate', 'app', 'b', '--port', String(siblingPort)], project)).toBe(0);
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      for (const member of ['a', 'b']) {
        for (const script of ['format:check', 'lint', 'check']) {
          const result = await npmRun(`${project}/apps/${member}`, script);
          expect(result.code, result.output).toBe(0);
        }
      }
      const pair = credentials();
      const launched = launchGroup('npm', ['run', 'dev'], project, {
        ...pair.env,
        SETU_DEVTOOL_MEMBER: 'a',
      });
      const client = nodeClient(port, pair);
      try {
        await eventually(
          async () => (await nodeReady(appPort)) && (await nodeReady(siblingPort)),
          'Both Node workspace members must become ready',
        );
        expect((await client.snapshot()).state).toBe('running');
        if (process.platform === 'linux') {
          const siblings = [];
          for (const row of await liveProcesses()) {
            if (!/node\s/.test(row.command) || !row.command.includes('main.ts')) continue;
            const cwd = await nodeFs.readlink(`/proc/${row.pid}/cwd`).catch(() => '');
            if (cwd !== `${project}/apps/b`) continue;
            siblings.push(row);
            const values = (await nodeFs.readFile(`/proc/${row.pid}/environ`, 'utf8')).split('\0');
            for (const name of [
              'SETU_DEVTOOL_MEMBER',
              'SETU_DEVTOOL_SESSION_ID',
              'SETU_DEVTOOL_SESSION_KEY',
            ]) {
              expect(
                values.includes(`${name}=`),
                `${name} must be blank in sibling node process`,
              ).toBe(true);
            }
            expect(row.group).toBe(launched.pid);
          }
          expect(siblings.length).toBeGreaterThan(0);
        }
        expect(launched.output().includes(pair.sessionId)).toBe(false);
        expect(launched.output().includes(pair.sessionKey)).toBe(false);
      } finally {
        client.close();
        await launched.stop();
      }
      expect(await acceptsConnection(appPort)).toBe(false);
      expect(await acceptsConnection(siblingPort)).toBe(false);
      expect(await acceptsConnection(port)).toBe(false);
    },
  );

  it(
    'exits non-zero without credentials, names the missing variable and binds neither port',
    { timeout: 300_000 },
    async () => {
      const port = await unusedPort();
      const appPort = await unusedPort();
      expect(await run(['new', 'node-refused', '--devtool', '--devtool-port', String(port)])).toBe(
        0,
      );
      const project = `${root}/node-refused`;
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      const launched = launchGroup('npm', ['run', 'dev'], project, {
        SETU_DEVTOOL_MEMBER: '',
        SETU_DEVTOOL_SESSION_ID: '',
        SETU_DEVTOOL_SESSION_KEY: '',
        PORT: String(appPort),
      });
      try {
        let code: number | null | undefined;
        void launched.status.then((value) => {
          code = value;
        });
        await eventually(
          () => code !== undefined,
          'Missing credentials must fail startup promptly',
        );
        expect(code).not.toBe(0);
        expect(code).not.toBeNull();
        expect(launched.output()).toContain('SETU_DEVTOOL_SESSION_ID is absent or malformed');
        expect(launched.output()).not.toContain('Listening on');
        expect(await acceptsConnection(port)).toBe(false);
        expect(await acceptsConnection(appPort)).toBe(false);
      } finally {
        await launched.stop();
      }
    },
  );
});

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
  const child = spawnProcess(denoBinary(), {
    args: ['task', 'dev'],
    cwd: project,
    env: { PORT: String(appPort), ...env },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  });
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
    await Promise.race([exiting, new Promise((resolve) => setTimeout(resolve, 100))]);
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
  // Eight sequential Deno processes (scaffold, add, fmt, two probes, check, dev boot,
  // driver): 23-28 s alone on develop at 47be7fe1, so the suite's 30 s default failed
  // it under a parallel `ci:local` run. 120 s still bounds a hang, as the boot test
  // below does at 240 s.
  it(
    'generates ready health/cache sources for dev while production keeps both disabled',
    {
      timeout: 120_000,
    },
    async () => {
      const devtoolPort = await unusedPort();
      const appPort = await unusedPort();
      expect(
        await run([
          'new',
          '--runtime',
          'deno',
          'sources',
          '--template',
          'rest',
          '--devtool',
          '--devtool-port',
          String(devtoolPort),
        ]),
      ).toBe(0);
      const project = `${root}/sources`;
      expect(await run(['add', 'cache'], project)).toBe(0);
      await useWorkspacePackages(project);
      const formatted = await denoRun(project, ['fmt', '--check']);
      expect(formatted.code, formatted.output).toBe(0);
      const configPath = `${project}/setu.config.ts`;
      const config =
        "import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';\n" +
        (await nodeFs.readFile(configPath, 'utf8')).replace(
          '  return app;',
          `  app.router.get('/cache-probe', async (ctx) => {
    const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
    await cache.set('probe', 'value');
    await cache.get('probe');
    return ctx.response.json({ ok: true });
  });
  return app;`,
        );
      await nodeFs.writeFile(configPath, config);
      const probe = `import { CAPABILITIES, type ICacheDiagnosticsSource, type IHealthDiagnosticsSource } from '@setu-ts/common';
import { createApp } from './setu.config.ts';
const app = createApp();
await app.start();
try {
  const health = app.services.get<IHealthDiagnosticsSource>(CAPABILITIES.HEALTH_DIAGNOSTICS).snapshot('production-probe');
  const cache = app.services.getAll<ICacheDiagnosticsSource>(CAPABILITIES.CACHE_DIAGNOSTICS).map((source) => source.snapshot());
  console.log(JSON.stringify({ health: health.state, cache: cache.map((source) => source.state) }));
} finally { await app.stop(); }
`;
      await nodeFs.writeFile(`${project}/production-probe.ts`, probe);
      const production = await denoRun(project, ['run', '-A', 'production-probe.ts']);
      expect(production.code, production.output).toBe(0);
      expect(production.stdout).toContain('"health":"disabled"');
      expect(production.stdout).toContain('"cache":["disabled"]');
      try {
        await nodeFs.writeFile(
          configPath,
          config.replace('devtool === undefined ? {} : DEVTOOL_SOURCES', 'DEVTOOL_SOURCES'),
        );
        const broken = await denoRun(project, ['run', '-A', 'production-probe.ts']);
        expect(broken.code, broken.output).toBe(0);
        expect(broken.stdout).not.toContain('"health":"disabled"');
        expect(broken.stdout).not.toContain('"cache":["disabled"]');
      } finally {
        await nodeFs.writeFile(configPath, config);
      }
      const checked = await denoRun(project, ['task', 'check']);
      expect(checked.code, checked.output).toBe(0);
      const credentials_ = credentials();
      const booted = await bootDev(project, appPort, credentials_.env);
      try {
        await nodeFs.writeFile(
          `${project}/source-driver.ts`,
          DRIVER.replace(
            'const snapshot = await client.snapshot();',
            `await fetch(\`http://127.0.0.1:\${appPort}/health\`);
await fetch(\`http://127.0.0.1:\${appPort}/cache-probe\`);
const health = await client.health();
const cache = await client.cache();
console.log('__SOURCES__' + JSON.stringify({ health, cache }));
const snapshot = await client.snapshot();`,
          ),
        );
        const driven = await denoRun(project, [
          'run',
          '--allow-net',
          'source-driver.ts',
          String(devtoolPort),
          String(appPort),
          credentials_.sessionId,
          credentials_.sessionKey,
        ]);
        expect(driven.code, driven.output).toBe(0);
        const reportLine = driven.stdout
          .split('\n')
          .find((line) => line.startsWith('__SOURCES__'))!;
        const report = JSON.parse(reportLine.slice('__SOURCES__'.length)) as {
          health: HealthDiagnosticsSnapshot;
          cache: CacheDiagnosticsResponse;
        };
        expect(report.health.state).toBe('ready');
        expect(report.health.observations.length).toBeGreaterThan(0);
        expect(report.cache.sources.length).toBe(1);
        expect(report.cache.state).toBe('ready');
        expect(report.cache.sources[0]?.snapshot.records.length).toBeGreaterThan(0);
      } finally {
        await booted.stop();
      }
    },
  );
  it('formats both standalone and workspace development entries without a repair', async () => {
    expect(await run(['new', '--runtime', 'deno', 'formatted', '--devtool'])).toBe(0);
    const standalone = await denoRun(`${root}/formatted`, ['fmt', '--check']);
    expect(standalone.output).not.toContain('not formatted');
    expect(standalone.code).toBe(0);
    expect(await run(['new', '--runtime', 'deno', 'workspace', '--workspace'])).toBe(0);
    expect(await run(['generate', 'app', 'orders', '--devtool'], `${root}/workspace`)).toBe(0);
    const member = await denoRun(`${root}/workspace/apps/orders`, ['fmt', '--check']);
    expect(member.output).not.toContain('not formatted');
    expect(member.code).toBe(0);
  });
  it('stops and exits when a hand-edited factory drops either part of the composition', async () => {
    for (const dropped of ['plugins', 'diagnostics']) {
      const appPort = await unusedPort();
      expect(
        await run([
          'new',
          '--runtime',
          'deno',
          dropped,
          '--devtool',
          '--devtool-port',
          String(await unusedPort()),
        ]),
      ).toBe(0);
      const project = `${root}/${dropped}`;
      await useWorkspacePackages(project);
      const path = `${project}/setu.config.ts`;
      const source = await nodeFs.readFile(path, 'utf8');
      await nodeFs.writeFile(
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
      expect(
        await fetch(`http://127.0.0.1:${appPort}/`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    }
  });

  it('boots a reallocated workspace entry and answers the signed client at its new port', async () => {
    const appPort = await unusedPort();
    const oldPort = await unusedPort();
    const newPort = await unusedPort();
    expect(
      await run(['new', '--runtime', 'deno', 'acme', '--workspace', '--port', String(appPort)]),
    ).toBe(0);
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
    const manifest = JSON.parse(await nodeFs.readFile(manifestPath, 'utf8'));
    manifest.devtoolBasePort = newPort;
    await nodeFs.writeFile(manifestPath, JSON.stringify(manifest));
    expect(await run(['workspace', 'ports', '--reallocate', '--dir', workspace])).toBe(0);
    const project = `${workspace}/apps/orders`;
    expect(await nodeFs.readFile(`${project}/main.dev.ts`, 'utf8')).toContain(`port: ${newPort},`);
    expect(await nodeFs.readFile(`${workspace}/.dockerignore`, 'utf8')).toContain(
      'apps/*/main.dev.ts',
    );
    await useWorkspacePackages(project);
    const pair = credentials();
    const booted = await bootDev(project, appPort, pair.env);
    try {
      await nodeFs.writeFile(`${project}/driver.ts`, DRIVER);
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
      // The driver emits JSON on stdout; Deno dependency diagnostics use stderr.
      expect(JSON.parse(result.stdout.trim().split('\n').pop()!).instanceId).not.toBeNull();
      expect(
        await fetch(`http://127.0.0.1:${oldPort}/v1/status`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    } finally {
      await booted.stop();
    }
  });
  it(
    'type-checks, boots with credentials, and answers the real client',
    { timeout: 240_000 },
    async () => {
      const devtoolPort = await unusedPort();
      const appPort = await unusedPort();
      expect(
        await run([
          'new',
          '--runtime',
          'deno',
          'shop',
          '--devtool',
          '--devtool-port',
          String(devtoolPort),
        ]),
      ).toBe(0);
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
        await nodeFs.writeFile(`${project}/driver.ts`, DRIVER);
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
    const devtoolPort = await unusedPort();
    const appPort = await unusedPort();
    expect(
      await run([
        'new',
        '--runtime',
        'deno',
        'shop',
        '--devtool',
        '--devtool-port',
        String(devtoolPort),
      ]),
    ).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);

    const refused = await denoRun(project, ['task', 'dev'], { PORT: String(appPort) });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('SETU_DEVTOOL_SESSION_ID is absent or malformed');
    // Nothing ever bound: the refusal happens before the connector starts.
    expect(refused.output).not.toContain('Listening on');
  });

  it('enables the devtool on a project carrying the pre-M98c factory, refusing first', async () => {
    const devtoolPort = await unusedPort();
    const appPort = await unusedPort();
    expect(await run(['new', '--runtime', 'deno', 'legacy'])).toBe(0);
    const project = `${root}/legacy`;

    // Rewrite the config to the shape every pre-M98c project carries: a
    // zero-parameter factory and NO devtool weave in the body — the shape
    // `deno run` silently discards arguments against.
    const configPath = `${project}/setu.config.ts`;
    const config = await nodeFs.readFile(configPath, 'utf8');
    await nodeFs.writeFile(
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
    const manifest = JSON.parse(await nodeFs.readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['//devtool-note'] = 'hand-written key';
    (manifest['tasks'] as Record<string, string>)['db:push'] = 'deno run -A tools/push.ts';
    await nodeFs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // The refusal: named, quoting the fix, writing NOTHING.
    const refused = await run(['devtool', 'enable', '--dir', project]);
    expect(refused).toBe(1);
    expect(await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8')).toContain(
      'export function createApp(): IApplication {',
    );
    expect(
      (JSON.parse(await nodeFs.readFile(manifestPath, 'utf8')) as { tasks: Record<string, string> })
        .tasks['dev'],
    ).toBeUndefined();

    const signatureOnly = (await nodeFs.readFile(configPath, 'utf8')).replace(
      'export function createApp(): IApplication {',
      'export function createApp(_env?: Readonly<Record<string, unknown>>, devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }): IApplication {',
    );
    await nodeFs.writeFile(configPath, signatureOnly);
    expect(await run(['devtool', 'enable', '--dir', project])).toBe(1);
    await nodeFs.writeFile(
      configPath,
      signatureOnly.replace(
        'export function createApp(_env?: Readonly<Record<string, unknown>>, devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }): IApplication {',
        'export function createApp(): IApplication {',
      ),
    );

    // Apply the edit the refusal names — the factory takes the devtool
    // composition as its SECOND parameter and the composition reaches the
    // constructor — exactly what a developer follows it with.
    await nodeFs.writeFile(
      configPath,
      (await nodeFs.readFile(configPath, 'utf8'))
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
    ).toBe(0);
    const after = JSON.parse(await nodeFs.readFile(manifestPath, 'utf8')) as {
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
      `npm:@setu-ts/diagnostics-plugin@^${VERSION}`,
    );
    // Repoint the pin at this workspace too, so the check and the boot below
    // measure the workspace source rather than a published snapshot —
    // the same repointing `useWorkspacePackages` performs, applied to the key
    // the enable flow just added.
    const repointed = { ...after };
    repointed.imports['@setu-ts/diagnostics-plugin'] = workspaceEntrypoint('diagnostics-plugin');
    await nodeFs.writeFile(manifestPath, `${JSON.stringify(repointed, null, 2)}\n`);

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
      await nodeFs.writeFile(`${project}/driver.ts`, DRIVER);
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

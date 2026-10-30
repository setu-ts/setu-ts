import {
  denoBinary,
  run as runProcess,
  spawnProcess,
  tempDir,
} from '../../../../test/node-helpers.ts';
import { fileURLToPath } from 'node:url';
import * as nodeFs from 'node:fs/promises';
/**
 * The gate M63 exists for: a stock scaffold is installed, formatted, linted,
 * type-checked, BOOTED under its own declared permissions, and asked for the
 * endpoints it advertises.
 *
 * Every defect this milestone repairs passed the existing drift gate, which
 * stops at `deno check`. Three of them could not have been caught by a
 * type-checker at all:
 *
 * - the generated `start` task never requested `--allow-sys`, so a stock `rest`
 *   project answered **500 on `/health`** — the path the generated Kubernetes
 *   probes point at;
 * - the `full-stack` member's `deno.json` carried the decorator option it does
 *   not use and no `jsx`, so every `.tsx` route failed to type-check while
 *   `vite build` succeeded;
 * - a fresh scaffold failed `deno fmt --check` on 62 of 74 files the CLI itself
 *   had just written.
 *
 * So the assertions here are behavioural, and the boot deliberately does NOT use
 * `-A`: see {@linkcode bootWithGeneratedPermissions}.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import type { Prompter } from '../../src/prompt.ts';
import { listTransports } from '../../src/workspace/transport.ts';
import {
  bootAndProbe,
  bootWithGeneratedPermissions,
  unusedPort,
  useWorkspacePackages,
  withGeneratedServer,
} from '../fixtures/generated-project.ts';
import {
  npmInstall,
  npmRun,
  runIn,
  startOverlay,
  withNodeServer,
} from '../fixtures/node-project.ts';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

// `class-based` runs the same request logger behind DI and decorator dispatch,
// so it gets the same one-line proof rather than relying on `rest`'s.
for (const template of ['rest', 'class-based'] as const) {
  it(
    `boots a pino-default ${template} scaffold and emits one numeric-level JSON request log`,
    { timeout: 900_000 },
    async () => {
      expect(await run(['new', 'pino-app', '--template', template, '--runtime', 'node'])).toBe(0);
      const project = `${root}/pino-app`;
      const overlay = await startOverlay();
      try {
        const installed = await npmInstall(project, overlay);
        expect(installed.code, installed.output).toBe(0);
        // M120: `npm start` runs the compiled bundle, so build first — which also
        // proves the pino logger works from the bundle (pino stays external).
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);
        const result = await withNodeServer(project, async (origin, output) => {
          const response = await fetch(`${origin}/greetings/log-probe`);
          await response.body?.cancel();
          // Pino's default stdout destination writes asynchronously, and the
          // server is SIGKILLed when this returns: wait (bounded) for the line.
          for (let waited = 0; waited < 10_000; waited += 50) {
            if (output().includes('"path":"/greetings/log-probe"')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return response.status;
        });
        expect(result.result, result.output).toBe(200);
        const lines = result.output
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(
          lines.filter((line) => line['path'] === '/greetings/log-probe'),
          result.output,
        ).toEqual([
          expect.objectContaining({
            level: 30,
            msg: 'request completed',
            requestId: expect.any(String),
            method: 'GET',
            path: '/greetings/log-probe',
            status: 200,
            duration: expect.any(Number),
          }),
        ]);
        expect(
          lines.filter((line) => line['msg'] === 'request received'),
          result.output,
        ).toEqual([]);
      } finally {
        await overlay.close();
      }
    },
  );
}

for (const target of ['deno', 'bun'] as const) {
  it(
    `runs the ${target} scaffold check task and catches a removed barrel import`,
    { timeout: 900_000 },
    async () => {
      expect(await run(['new', 'shop', '--runtime', target, '--template', 'rest'])).toBe(0);
      const project = `${root}/shop`;
      const overlay = await startOverlay();
      try {
        const install = await runIn(project, target, ['install'], overlay);
        expect(install.code, install.output).toBe(0);
        const args = target === 'deno' ? ['task', 'check'] : ['run', 'check'];
        const fresh = await runIn(project, target, args, overlay);
        expect(fresh.code, fresh.output).toBe(0);
        const path = `${project}/src/controllers/index.ts`;
        const source = await nodeFs.readFile(path, 'utf8');
        const removed = source.replace(
          /import\s+\{[^}]*\}\s+from\s*[\x27\x22]\.\/greeting\.controller\.ts[\x27\x22];?/,
          '',
        );
        expect(removed).not.toBe(source);
        // Keep the barrel type-correct so the wiring gate is the failing half.
        const emptied = removed.replace(/\[\s*registerGreetingRoutes,?\s*\]/, '[]');
        expect(emptied).not.toBe(removed);
        await nodeFs.writeFile(path, emptied);
        const broken = await runIn(project, target, args, overlay);
        expect(broken.code, broken.output).not.toBe(0);
        expect(broken.output).toContain('setu.E003');
        expect(broken.output).toContain('greeting.controller.ts');
      } finally {
        await overlay.close();
      }
    },
  );
}

// The full-stack Deno manifest is the other `denoTasks` arm (it has an npm
// build), so its `check` task is proven separately: it must pass on a fresh
// install without a prior build, and say it found no CLI-owned seams.
it('runs the deno full-stack scaffold check task', { timeout: 900_000 }, async () => {
  expect(await run(['new', 'shop', '--runtime', 'deno', '--template', 'full-stack'])).toBe(0);
  const project = `${root}/shop`;
  const overlay = await startOverlay();
  try {
    const install = await runIn(project, 'deno', ['task', 'install'], overlay);
    expect(install.code, install.output).toBe(0);
    const checked = await runIn(project, 'deno', ['task', 'check'], overlay);
    expect(checked.code, checked.output).toBe(0);
    expect(checked.output).toContain('setu check: 0 error(s)');
  } finally {
    await overlay.close();
  }
});

/** Templates that wire an HTTP surface and boot without an npm build. */
// X5-3's fix and its gate are the same change: `full-stack` was excluded from
// this list because it could not boot — it had no `build` task, so `deno task
// start` died on a missing server build. The one template that could not boot
// was the one the boot gate skipped. It now emits `install`/`build` and `start`
// depends on `build`, so it belongs here.
const BOOTABLE = ['rest', 'microservice', 'class-based', 'full-stack'] as const;
const DOCS_PATHS = [
  '/docs',
  '/docs/swagger-ui.css',
  '/docs/swagger-ui-bundle.js',
  '/docs/swagger-ui-standalone-preset.js',
] as const;

/**
 * Every host a scaffold can produce, including the no-template one.
 *
 * The Workers arms are here because this gate only ever scaffolded the DEFAULT
 * runtime, so nothing checked a `--runtime cloudflare-workers` project at all —
 * and one shipped failing its own `deno fmt --check` on two files, which is
 * exactly the defect class X2-4 reported for `--transport`. A target the gate
 * does not scaffold is a target with no gate.
 */
const HOSTS: readonly (readonly [label: string, args: readonly string[]])[] = [
  ['no-template', []],
  ['rest', ['--template', 'rest']],
  ['microservice', ['--template', 'microservice']],
  ['class-based', ['--template', 'class-based']],
  ['full-stack', ['--template', 'full-stack']],
  ['rest on workers', ['--template', 'rest', '--runtime', 'cloudflare-workers']],
  // The one that failed: its Cloudflare wiring is the longest emitted plugin
  // call, and it emits a Durable Object class of its own.
  ['microservice on workers', ['--template', 'microservice', '--runtime', 'cloudflare-workers']],
  // The styled host: the same microservice recipe composed with the decorator
  // and DI pair. A `HOSTS` entry alone only reaches `fmt` and `lint` — the boot
  // gets its own case in `BOOTABLE_STYLED` below.
  ['microservice class-based', ['--template', 'microservice', '--style', 'class-based']],
  [
    'microservice class-based on workers',
    ['--template', 'microservice', '--style', 'class-based', '--runtime', 'cloudflare-workers'],
  ],
];

let root = '';

beforeEach(async () => {
  root = await tempDir({ prefix: 'setu-scaffold-runs-' });
});

afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
}, 30_000);

/**
 * Runs the CLI with the temp root as its working directory.
 *
 * @param args - Arguments after the program name
 * @returns The exit code
 */
async function run(args: readonly string[]): Promise<number> {
  return await runCli(args, {
    fs,
    cwd: root,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

for (const spec of listTransports()) {
  for (const flag of ['broker', 'queue'] as const) {
    if ((flag === 'broker' ? spec.messagingArgs : spec.queueArgs) === undefined) continue;
    for (const target of ['deno', 'node'] as const) {
      it(
        `formats full-stack ${target} --${flag} ${spec.name} as rendered`,
        { timeout: 120_000 },
        async () => {
          expect(
            await run([
              'new',
              'portal',
              '--runtime',
              target,
              '--template',
              'full-stack',
              `--${flag}`,
              spec.name,
            ]),
          ).toBe(0);
          const project = `${root}/portal`;
          const result =
            target === 'deno'
              ? await denoRun(project, ['fmt', '--check'])
              : await runIn(project, process.execPath, [
                  new URL('../../../../node_modules/prettier/bin/prettier.cjs', import.meta.url)
                    .pathname,
                  '--check',
                  '.',
                ]);
          expect(result.code, result.output).toBe(0);
          if (target === 'deno' && spec.name === 'redis') {
            await useWorkspacePackages(project);
            const checked = await denoRun(project, ['check', 'setu.config.ts']);
            expect(checked.code, checked.output).toBe(0);
          }
        },
      );
    }
  }
}

/**
 * Runs one Deno subcommand inside a project.
 *
 * @param project - The project directory
 * @param args - The subcommand and its flags
 * @returns Its exit code and combined output
 */
async function denoRun(
  project: string,
  args: readonly string[],
): Promise<{ code: number; output: string }> {
  return await runDenoOnce(project, args);
}

/**
 * The longest a single `deno` subprocess may run before it is killed and the
 * attempt counted as a transient failure. Generous on purpose: a cold
 * `deno install` that downloads the whole framework graph can take minutes on a
 * contended runner, and a premature timeout would turn a slow-but-valid install
 * into a spurious failure.
 */
const DENO_RUN_TIMEOUT_MS = 300_000;

/** How many times a transient `deno install` failure is retried. */
const DENO_INSTALL_ATTEMPTS = 3;

/** The pause between retry attempts, so a momentary registry blip can clear. */
const DENO_INSTALL_RETRY_DELAY_MS = 2_000;

/**
 * A `deno install` failure that is a transient network condition rather than a
 * deterministic one: the registry connection is dropped or reset mid-download,
 * or the request times out. These are the failures the full-suite parallel load
 * produces. Every other failure — a version the registry does not publish, a
 * `minimum dependency age` refusal, a lock or resolution error — is
 * deterministic and must NOT be retried, because retrying it would mask a real
 * defect and burn the whole attempt budget.
 */
function isTransientInstallFailure(output: string): boolean {
  const haystack = output.toLowerCase();
  const markers = [
    'network error',
    'error sending request',
    'error trying to connect',
    'connection reset',
    'connection refused',
    'timed out',
    'tls error',
    'temporarily unavailable',
  ];
  return markers.some((m) => haystack.includes(m));
}

/**
 * Runs one `deno` subprocess, killing it if it exceeds
 * {@linkcode DENO_RUN_TIMEOUT_MS} so a blackholed network can never hang the
 * whole suite. A timed-out attempt reports a non-zero code with a marker in its
 * output, so the caller can treat it as a transient failure.
 *
 * @param project - The project directory
 * @param args - The subcommand and its flags
 * @returns Its exit code and combined output
 */
async function runDenoOnce(
  project: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; output: string }> {
  const child = spawnProcess(denoBinary(), {
    args: [...args],
    cwd: project,
    env: { ...env },
    stdout: 'piped',
    stderr: 'piped',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may already have exited; the status read below still resolves.
    }
  }, DENO_RUN_TIMEOUT_MS);

  // Drain both pipes CONCURRENTLY with the status wait, never after it. A pipe
  // holds ~64 KB; past that the child blocks on write until someone reads, so
  // awaiting `status` first deadlocks on any subprocess with more output than
  // that. It would then be SIGKILLed at the timeout and — because the timeout
  // marker reads as a network condition — retried to exhaustion, turning a
  // merely chatty command into a multi-minute spurious failure.
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);

  if (timedOut) {
    return {
      code: 1,
      output: `deno subprocess timed out after ${DENO_RUN_TIMEOUT_MS}ms:\n${stdout}${stderr}`,
    };
  }
  return { code: status.code ?? 1, output: `${stdout}${stderr}` };
}

/**
 * Runs one Deno subcommand inside a project, retrying transient network
 * failures.
 *
 * `deno install` is the only subprocess this gate runs that performs real
 * registry I/O, and it runs while the rest of the suite is spawning dozens of
 * other `deno` processes in parallel. Under that load a single install can lose
 * its connection to the registry mid-download and exit non-zero, even though
 * the same install succeeds on its own or on a quieter run — the flake this
 * helper absorbs. Only a failure that looks like a transient network condition
 * is retried; a deterministic failure (a missing version, a dependency-age
 * refusal, a resolution error) is returned on its first attempt so the test
 * still fails on a real defect.
 *
 * @param project - The project directory
 * @param args - The subcommand and its flags
 * @returns Its exit code and combined output
 */
async function denoRunRetry(
  project: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; output: string }> {
  let result = await runDenoOnce(project, args, env);
  for (let attempt = 1; attempt < DENO_INSTALL_ATTEMPTS; attempt++) {
    if (result.code === 0 || !isTransientInstallFailure(result.output)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, DENO_INSTALL_RETRY_DELAY_MS));
    result = await runDenoOnce(project, args, env);
  }
  return result;
}

/**
 * Runs Prettier's check over an npm-target project with the CLI's own Prettier,
 * which reads the project's `.prettierrc.json` and `.prettierignore` — so the
 * check needs no install.
 *
 * @param project - The project directory
 * @returns Its exit code and combined output
 */
async function prettierCheck(project: string): Promise<{ code: number; output: string }> {
  const bin = fileURLToPath(
    new URL('../../node_modules/prettier/bin/prettier.cjs', import.meta.url),
  );
  const result = await runProcess(process.execPath, {
    args: [bin, '--check', '.'],
    cwd: project,
    stdout: 'piped',
    stderr: 'piped',
  });
  const decoder = new TextDecoder();
  return {
    code: result.code,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

describe('a scaffolded project is formatted and lints clean', () => {
  for (const [label, args] of HOSTS) {
    it(`holds for ${label}`, async () => {
      // Deno unless the host names its own target: this gate formats and lints
      // with Deno, and the npm hosts get the same treatment on Node in
      // `node-scaffold-e2e.test.ts`.
      const workers = args.includes('cloudflare-workers');
      const runtime = workers ? [] : ['--runtime', 'deno'];
      expect(await run(['new', 'shop', ...runtime, ...args])).toBe(0);
      const project = `${root}/shop`;

      // The generated project carries its own formatter config; this asserts
      // the CLI's output already satisfies it, so a developer's first format
      // run does not rewrite files they did not write. A Workers project is an
      // npm target, formatted with Prettier — `deno fmt` is not its formatter.
      const formatted = workers
        ? await prettierCheck(project)
        : await denoRun(project, ['fmt', '--check']);
      expect(formatted.code, formatted.output).toBe(0);

      const linted = await denoRun(project, ['lint']);
      expect(linted.code, linted.output).toBe(0);
    });
  }
});

/**
 * The paths a generated README's "What it serves" section lists, with each
 * `:name` segment filled in, so they can be requested as written.
 */
async function advertisedPaths(project: string): Promise<string[]> {
  const readme = await nodeFs.readFile(`${project}/README.md`, 'utf8');
  const section = readme.split('## What it serves')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((match) =>
    (match[1] as string).replaceAll(/:[a-z]+/g, 'Setu'),
  );
}

describe('a scaffolded project serves its own advertised endpoints', () => {
  it('uses TRUSTED_PROXIES for a full-stack TLS action (V10-17)', async () => {
    expect(await run(['new', '--runtime', 'node', 'proxy-shop', '--template', 'full-stack'])).toBe(
      0,
    );
    const project = `${root}/proxy-shop`;
    const overlay = await startOverlay();
    try {
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      const built = await runIn(project, 'npm', ['run', 'build']);
      expect(built.code, built.output).toBe(0);
      await nodeFs.writeFile(
        `${project}/proxy-probe.ts`,
        `
import assert from 'node:assert/strict';
import { requestOriginOf, CLIENT_IP_STATE_KEY } from '@setu-ts/common';
import { createApp } from './setu.config.ts';
// §8a.1.5-6: unset/empty lists add no IP security; a listed peer is trusted;
// an unmatched or malformed-but-literal entry (compared literally) trusts nothing.
const options = [undefined, '', ',', ' , ', '192.0.2.1/32', '127.0.0.1/32', 'example', '10.0.0.0/33', '::1/129'];
const port = Number(process.argv[2]);
const origin = 'http://127.0.0.1:' + port;
for (const proxies of options) {
  if (proxies === undefined) delete process.env['TRUSTED_PROXIES'];
  else process.env['TRUSTED_PROXIES'] = proxies;
  const app = await createApp();
  const middlewareNames: (string | undefined)[] = [];
  const addMiddleware = app.middleware.add.bind(app.middleware);
  app.middleware.add = (fn, options) => { middlewareNames.push(options?.name); addMiddleware(fn, options); };
  app.router.get('/identity-probe', (ctx) => ctx.response.json({ ip: ctx.state.get(CLIENT_IP_STATE_KEY) ?? ctx.request.ip, origin: requestOriginOf(ctx).origin }));
  await app.start({ port, hostname: '127.0.0.1' });
  try {
    const listed = (proxies ?? '').split(',').some((entry) => entry.trim() !== '');
    assert.equal(middlewareNames.includes('IpSecurityMiddleware'), listed);
    const headers = { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Host': 'public.example', 'X-Forwarded-Proto': 'https' };
    const trusted = proxies === '127.0.0.1/32';
    const identity = await fetch(origin + '/identity-probe', { headers });
    assert.deepEqual(await identity.json(), { ip: trusted ? '203.0.113.9' : '127.0.0.1', origin: trusted ? 'https://public.example' : origin });
    const page = await fetch(origin + '/login', { headers });
    assert.equal(page.status, 200);
    const token = /name="_csrf"\\s+value="([^"]+)"/.exec(await page.text())?.[1];
    assert.ok(token);
    const cookie = page.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ');
    // The scaffold uses the session plugin's secure:true default on both paths.
    assert.equal(page.headers.getSetCookie().some((line) => /; Secure/i.test(line)), true);
    const action = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: {
      ...headers, cookie, Origin: 'https://public.example', 'Sec-Fetch-Site': 'same-origin',
    }, body: new URLSearchParams({ _csrf: token, email: 'ada@example.com' }) });
    assert.equal(action.status, trusted ? 302 : 400, String(proxies) + ': ' + await action.text());
    console.log('PROXY_CASE', JSON.stringify(proxies), action.status);
  } finally { await app.stop(); }
}
// §8a.1.6: a CIDR width that is not plain digits fails start() with the named
// error rather than compiling to a mask that trusts every address.
for (const proxies of ['10.0.0.1/', '10.0.0.0/0x20']) {
  process.env['TRUSTED_PROXIES'] = proxies;
  // Refused at construction or at start(), whichever builds the middleware.
  await assert.rejects(async () => {
    const app = await createApp();
    try { await app.start({ port, hostname: '127.0.0.1' }); } finally { await app.stop(); }
  }, /malformed CIDR width/);
  console.log('PROXY_CASE', JSON.stringify(proxies), 'refused');
}
`,
      );
      const proof = await runIn(project, `${project}/node_modules/.bin/tsx`, [
        'proxy-probe.ts',
        String(await unusedPort()),
      ]);
      expect(proof.code, proof.output).toBe(0);
      expect(proof.output.match(/PROXY_CASE/g)).toHaveLength(11);
    } finally {
      await overlay.close();
    }
  }, 900_000);

  it('boots the printed setu add telemetry registration with its installed peers (V10-6)', async () => {
    expect(await run(['new', '--runtime', 'node', 'traced'])).toBe(0);
    const project = `${root}/traced`;
    const output: string[] = [];
    expect(
      await runCli(['add', 'telemetry'], {
        fs,
        cwd: project,
        now: () => runtime.now(),
        log: (line) => output.push(line),
        error: (line) => output.push(line),
      }),
    ).toBe(0);
    const registration = /Register (TelemetryPlugin\(.+\)) in setu.config.ts\./.exec(
      output.join('\n'),
    )?.[1];
    expect(registration).toBeDefined();
    const configPath = `${project}/setu.config.ts`;
    const config = await nodeFs.readFile(configPath, 'utf8');
    await nodeFs.writeFile(
      configPath,
      `import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';\n` +
        config.replace('RuntimePlugin(),', `RuntimePlugin(), ${registration},`),
    );
    const overlay = await startOverlay();
    try {
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      const booted = await withNodeServer(project, async (origin) => (await fetch(origin)).status);
      expect(booted.result, booted.output).toBe(200);
    } finally {
      await overlay.close();
    }
  }, 900_000);

  it('runs two generated migrations twice in one serving app and reflects the ledger in /ready', async () => {
    expect(await run(['new', 'shop', '--runtime', 'deno', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    expect(await run(['add', 'database', '--dir', project])).toBe(0);
    expect(await run(['g', 'migration', 'one', '--dir', project])).toBe(0);
    expect(await run(['g', 'migration', 'two', '--dir', project])).toBe(0);
    const configPath = `${project}/setu.config.ts`;
    const config = await nodeFs.readFile(configPath, 'utf8');
    expect(config).toContain('...GENERATED_PLUGINS,');
    await nodeFs.writeFile(
      configPath,
      "import { MIGRATION_NAMES } from './src/migrations/index.ts';\n" +
        "import { DatabasePlugin } from '@setu-ts/database-plugin';\n" +
        config.replace(
          '      ...GENERATED_PLUGINS,',
          '      DatabasePlugin({ readiness: { migrations: MIGRATION_NAMES } }),\n      ...GENERATED_PLUGINS,',
        ),
    );
    await useWorkspacePackages(project);
    await nodeFs.writeFile(
      `${project}/migration-proof.ts`,
      `
import { CAPABILITIES } from '@setu-ts/common';
import { createMigrationLedger } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApp } from './setu.config.ts';
import { runMigrations } from './src/migrations/run.ts';
import { MIGRATION_NAMES } from './src/migrations/index.ts';
const app = await createApp();
try {
  await app.start();
  const ready = () => app.inject({ method: 'GET', url: 'http://127.0.0.1/ready' });
  if ((await ready()).statusCode !== 503) throw new Error('pending must be unready');
  const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const ledger = createMigrationLedger(database);
  await runMigrations('up', { database, ledger });
  await runMigrations('up', { database, ledger });
  if (JSON.stringify(await ledger.applied()) !== JSON.stringify(MIGRATION_NAMES)) throw new Error('history differs');
  await new Promise((resolve) => setTimeout(resolve, 5100));
  if ((await ready()).statusCode !== 200) throw new Error('current must be ready');
} finally { await app.stop(); }
`,
    );
    const formatted = await denoRun(project, ['fmt']);
    expect(formatted.code, formatted.output).toBe(0);
    const linted = await denoRun(project, ['lint']);
    expect(linted.code, linted.output).toBe(0);
    const checked = await denoRun(project, ['check', 'migration-proof.ts']);
    expect(checked.code, checked.output).toBe(0);
    const proof = await denoRun(project, [
      'run',
      '-A',
      '--node-modules-dir=none',
      'migration-proof.ts',
    ]);
    expect(proof.code, proof.output).toBe(0);
    expect(proof.output.match(/^up /gm)).toHaveLength(2);
  });

  it('boots a Node REST scaffold with self-hosted Swagger assets', async () => {
    expect(await run(['new', '--runtime', 'node', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    const overlay = await startOverlay();
    try {
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      const readme = await nodeFs.readFile(`${project}/README.md`, 'utf8');
      const command = readme
        .split('\n')
        .find((line) => /^npx @setu-ts\/cli@\S+ generate service billing$/.test(line));
      expect(command).toBeDefined();
      const [executable, ...args] = command!.split(' ');
      const generated = await runIn(project, executable!, args, overlay);
      expect(generated.code, generated.output).toBe(0);
      expect(await nodeFs.readFile(`${project}/src/services/billing.service.ts`, 'utf8')).toContain(
        'billing',
      );
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      const booted = await withNodeServer(project, async (origin) => {
        const statuses: number[] = [];
        // `/health` is requested too, so the log assertions below can prove the
        // scaffold's configured exclusion actually suppresses its line.
        for (const path of [...DOCS_PATHS, '/health']) {
          statuses.push((await fetch(`${origin}${path}`)).status);
        }
        return statuses;
      });
      expect(booted.result, booted.output).toEqual([200, 200, 200, 200, 200]);
      // M113h §3.9: Node used to boot silently. The kernel announces the bound
      // port, the opt-in request logger reports a normal request, and the
      // generated `excludePaths` keeps a probe's line out of the log.
      expect(booted.output).toContain('Server listening');
      expect(booted.output).toContain('"msg":"request completed"');
      expect(booted.output).toContain('"path":"/"');
      expect(booted.output).not.toContain('"/health"');
    } finally {
      await overlay.close();
    }
    // An npm install plus a Node boot: the 30 s default timed out on CI, so this
    // takes the budget the other npm-installing e2e cases use.
  }, 900_000);
  // Membership is asserted, not just iterated. Removing a template from
  // `BOOTABLE` makes its build-and-boot assertions VANISH rather than fail, so
  // the whole gate stays green while covering strictly less — a one-word edit
  // that hides exactly the defect X5-3 was. `full-stack` is named because it is
  // the template that was excluded for years precisely because it could not
  // boot; this is the M37c `ALLOW_SKIP` precedent, where the exemption for the
  // one app that mattered would likewise have left CI green.
  it('never quietly drops a template from the boot list', () => {
    expect([...BOOTABLE]).toEqual(['rest', 'microservice', 'class-based', 'full-stack']);
  });

  it('boots a REST scaffold selected through the programmatic prompt seam', async () => {
    const ask: Prompter = {
      select(_question, choices) {
        const selected = choices.find((choice) => choice.value === 'rest') ?? choices[0];
        return Promise.resolve({ kind: 'answer', value: selected.value });
      },
    };
    expect(
      await runCli(['new', '--runtime', 'deno', 'shop'], {
        fs,
        cwd: root,
        now: () => runtime.now(),
        log: () => {},
        error: () => {},
        ask,
      }),
    ).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);

    const result = await bootWithGeneratedPermissions(project, ['/health', '/greetings']);
    expect(result.statuses['/health'], result.output).toBe(200);
    expect(result.statuses['/greetings'], result.output).toBe(200);
  });

  for (const template of BOOTABLE) {
    it(
      `holds for --template ${template}`,
      { timeout: template === 'full-stack' ? 900_000 : 30_000 },
      async () => {
        expect(await run(['new', '--runtime', 'deno', 'shop', '--template', template])).toBe(0);
        const project = `${root}/shop`;
        await useWorkspacePackages(project);

        // No separate build first, even for `full-stack`: a fresh user runs
        // `deno task test` on a project that has never been built, and the
        // generated smoke test boots an app that loads the server build. The
        // task must build it itself (V8-39) — pre-building here hid exactly that.
        // The build it leaves behind is what the boot below serves. Retried like
        // any install, since for `full-stack` this task now runs `deno install`.
        const tested = await denoRunRetry(project, ['task', 'test']);
        expect(tested.code, tested.output).toBe(0);
        expect(tested.output).toMatch(/\b[1-9]\d* passed/);
        const e2e = await denoRunRetry(project, ['task', 'test:e2e']);
        expect(e2e.code, e2e.output).toBe(0);

        // Every path the README's "What it serves" section lists must answer,
        // so the section cannot advertise a route the project does not serve.
        const advertised = await advertisedPaths(project);
        // Vacuity guard: every bootable template lists at least `/` and the six
        // plugin endpoints, so fewer means the section or its parser broke.
        expect(advertised.length, advertised.join(' ')).toBeGreaterThanOrEqual(7);
        const paths = [
          ...new Set([
            ...DOCS_PATHS,
            '/health',
            '/ready',
            '/metrics',
            ...(template === 'rest' ? ['/greetings', '/greetings/Setu'] : []),
            ...advertised,
          ]),
        ];
        const result = await bootWithGeneratedPermissions(project, paths);
        for (const path of DOCS_PATHS) expect(result.statuses[path], result.output).toBe(200);
        for (const path of advertised) {
          // `fetch` follows redirects, so a page behind sign-in lands on the
          // sign-in form and answers 200 as well.
          expect({ path, status: result.statuses[path] }, result.output).toEqual({
            path,
            status: 200,
          });
        }

        // The assertion D2 failed: without `--allow-sys` the self indicator's
        // `runtime.hostname()` throws and the probe answers 500.
        expect(result.statuses['/health'], result.output).toBe(200);
        expect(result.statuses['/ready'], result.output).toBe(200);
        expect(result.statuses['/metrics'], result.output).toBe(200);

        // Not merely a 200: a health body reporting `down` would also be a 200
        // shaped failure on some configurations.
        expect(result.bodies['/health']).toContain('"status":"up"');

        if (template === 'rest') {
          expect(result.statuses['/greetings'], result.output).toBe(200);
          expect(result.statuses['/greetings/Setu'], result.output).toBe(200);
          expect(result.bodies['/greetings']).toContain('Hello, world!');
          expect(result.bodies['/greetings/Setu']).toContain('Hello, Setu!');
        }
      },
    );
  }

  it('runs a smoke test on the template-less host', async () => {
    expect(await run(['new', '--runtime', 'deno', 'minimal'])).toBe(0);
    const project = `${root}/minimal`;
    await useWorkspacePackages(project);
    const configPath = `${project}/setu.config.ts`;
    const config = await nodeFs.readFile(configPath, 'utf8');
    // The old annotation hides inject/unregister/hasPlugin. This control must
    // fail at the actual testing-package boundary, not just a text assertion.
    await nodeFs.writeFile(
      configPath,
      config
        .replace('): IKernelApplication {', '): IApplication {')
        .replace(/type IKernelApplication,\s*/g, '')
        .replace(
          "import type { IPlugin } from '@setu-ts/common';",
          "import type { IApplication, IPlugin } from '@setu-ts/common';",
        ),
    );
    try {
      const refused = await denoRun(project, ['check', 'test/app.test.ts']);
      expect(refused.code, refused.output).not.toBe(0);
      expect(refused.output).toContain('TS2739');
      expect(refused.output).toContain('inject, unregister, hasPlugin');
    } finally {
      await nodeFs.writeFile(configPath, config);
    }
    const tested = await denoRun(project, ['task', 'test']);
    expect(tested.code, tested.output).toBe(0);
    expect(tested.output).toContain('1 passed');
  });

  // The styled host gets its OWN boot case rather than a `HOSTS` entry: `HOSTS`
  // drives only `fmt --check` and `lint`, and the loop above iterates `BOOTABLE`
  // — a `HOSTS` entry alone would never boot. `BOOTABLE` stays the four template
  // names, so dropping the styled arm must fail here, not vanish.
  const BOOTABLE_STYLED: readonly (readonly [label: string, args: readonly string[]])[] = [
    ['microservice --style class-based', ['--template', 'microservice', '--style', 'class-based']],
  ];

  it('never quietly drops the styled host from the boot list', () => {
    expect(BOOTABLE_STYLED.map(([label]) => label)).toEqual(['microservice --style class-based']);
  });

  for (const [label, args] of BOOTABLE_STYLED) {
    it(`boots with generated permissions for ${label}`, async () => {
      expect(await run(['new', '--runtime', 'deno', 'shop', ...args])).toBe(0);
      const project = `${root}/shop`;
      await useWorkspacePackages(project);

      const result = await bootWithGeneratedPermissions(project, ['/health', '/ready', '/metrics']);
      expect(result.statuses['/health'], result.output).toBe(200);
      expect(result.statuses['/ready'], result.output).toBe(200);
      expect(result.statuses['/metrics'], result.output).toBe(200);
      expect(result.bodies['/health']).toContain('"status":"up"');
    });
  }
});

describe('a scaffolded Workers project retries a failed boot and never leaks the stack', () => {
  // X9-8: `booted ??= boot(env)` cached the raw promise, so ONE failed boot was
  // permanent for the isolate's life AND the raw error reached the client. The
  // generated entry must answer a generic 503 while reporting to the platform
  // logs, and a later request must re-attempt boot.
  it('answers 503 without the stack, and the next request re-attempts boot', async () => {
    expect(
      await run(['new', 'shop', '--template', 'rest', '--runtime', 'cloudflare-workers']),
    ).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);

    // A config whose FIRST construction fails with an error carrying a path
    // marker — under the old memoisation both requests would replay this
    // failure and the message would leak into the response body.
    await nodeFs.writeFile(
      `${project}/setu.config.ts`,
      `import type { IApplication } from '@setu-ts/common';\n` +
        `let calls = 0;\n` +
        `export function createApp(_env?: Readonly<Record<string, unknown>>): IApplication {\n` +
        `  calls++;\n` +
        `  if (calls === 1) {\n` +
        `    throw new Error('transient cold-start failure at /srv/node_modules/@setu-ts');\n` +
        `  }\n` +
        `  return {\n` +
        `    start: () => Promise.resolve(),\n` +
        `    stop: () => Promise.resolve(),\n` +
        `    fetch: () => Promise.resolve(new Response('recovered')),\n` +
        `  } as unknown as IApplication;\n` +
        `}\n`,
    );

    const result = await bootAndProbe(
      project,
      `const entry = await import('./src/index.ts');\n` +
        `const first = await entry.default.fetch(\n` +
        `  new Request('http://localhost/health'), {},\n` +
        `);\n` +
        `const body1 = await first.text();\n` +
        `const second = await entry.default.fetch(\n` +
        `  new Request('http://localhost/health'), {},\n` +
        `);\n` +
        `const body2 = await second.text();\n` +
        `console.log('__PROBE_RESULT__' + JSON.stringify({\n` +
        `  status1: first.status,\n` +
        `  leakedStack: body1.includes('node_modules') || body1.includes('transient'),\n` +
        `  status2: second.status,\n` +
        `  body2,\n` +
        `}));\n`,
    );

    // First request after a failed boot: generic 503, no stack.
    expect(result['status1']).toBe(503);
    expect(result['leakedStack']).toBe(false);

    // The discriminating assertion: the SECOND request retried the boot and
    // succeeded. Under `??=` it would have replayed the cached rejection.
    expect(result['status2']).toBe(200);
    expect(result['body2']).toBe('recovered');
  });
});

describe('a scaffolded project configures itself from a dotenv file', () => {
  it('emits an ignored dotenv file beside a tracked example', async () => {
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;

    expect((await nodeFs.stat(`${project}/.env`)).isFile()).toBe(true);
    expect((await nodeFs.stat(`${project}/.env.example`)).isFile()).toBe(true);
    // The example is the committed one, so the ignore rule must name only the
    // real file — an ignore of `.env*` would take the example with it.
    const gitignore = await nodeFs.readFile(`${project}/.gitignore`, 'utf8');
    expect(gitignore).toContain('.env\n');
    expect(gitignore).not.toContain('.env.example');
  });

  it('boots with no dotenv file at all — the state of every fresh clone', async () => {
    // The regression this exists for: the CLI emits `.env`, gitignores it, and
    // wires `ConfigPlugin({ envFilePath: '.env' })`, which throws on a missing
    // file. So the project ran only on the machine that generated it and died
    // at `ConfigPlugin.register` on the first `git clone`, in CI, and inside a
    // container built from the repository. Deleting the file here reproduces
    // exactly that state; `envFileOptional` is what makes it boot.
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await nodeFs.rm(`${project}/.env`);

    const result = await bootWithGeneratedPermissions(project, ['/health']);

    expect(result.statuses['/health'], result.output).toBe(200);
  });

  it('reads values from the dotenv file it emitted', async () => {
    // The other half: tolerating absence must not mean ignoring the file. This
    // asserts the configured path is genuinely loaded, so a fix that silently
    // stopped reading dotenv files would fail here rather than pass both ways.
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await nodeFs.writeFile(`${project}/.env`, 'SCAFFOLD_PROBE_VALUE=from-dotenv\n');
    await nodeFs.writeFile(
      `${project}/src/controllers/index.ts`,
      `import { CAPABILITIES } from '@setu-ts/common';\n` +
        `import type { IConfig, IRouterApi } from '@setu-ts/common';\n\n` +
        `export function registerGeneratedRoutes(router: IRouterApi): void {\n` +
        `  router.get('/probe-config', (ctx) => {\n` +
        `    const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);\n` +
        `    return ctx.response.json({ value: config.get<string>('SCAFFOLD_PROBE_VALUE') });\n` +
        `  });\n` +
        `}\n`,
    );

    const result = await bootWithGeneratedPermissions(project, ['/probe-config']);

    expect(result.statuses['/probe-config'], result.output).toBe(200);
    expect(result.bodies['/probe-config']).toContain('from-dotenv');
  });
});

describe('a scaffolded project answers errors as RFC 9457 Problem Details', () => {
  it('serves the documented body and media type from a thrown error', async () => {
    // S4's actual claim. Asserted through a booted app rather than by matching
    // `errorHandler({ format: 'rfc9457' })` in the emitted source: the format
    // argument reaching the middleware is the only thing that decides the wire
    // shape, and a string match cannot see whether it did.
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await nodeFs.writeFile(
      `${project}/src/controllers/index.ts`,
      `import { unauthorized } from '@setu-ts/exceptions';\n` +
        `import type { IRouterApi } from '@setu-ts/common';\n\n` +
        `export function registerGeneratedRoutes(router: IRouterApi): void {\n` +
        `  router.get('/boom', () => {\n` +
        `    throw unauthorized('Token expired');\n` +
        `  });\n` +
        `}\n`,
    );

    const result = await bootWithGeneratedPermissions(project, ['/boom']);

    expect(result.statuses['/boom'], result.output).toBe(401);
    const body = JSON.parse(result.bodies['/boom']) as Record<string, unknown>;
    // Field by field, absences included: `message` is the pre-M56 default
    // format's field and must NOT appear beside Problem Details members.
    expect(body['type']).toBe('about:blank');
    expect(body['title']).toBe('Unauthorized');
    expect(body['status']).toBe(401);
    expect(body['detail']).toBe('Token expired');
    expect(body['message']).toBeUndefined();
  });

  it('a validation failure and a thrown error answer with the same Problem Details members (C3)', async () => {
    // C3's CLI half: the `rest` template pairs `ValidationPlugin({ errorFormat:
    // 'rfc9457' })` with `errorHandler({ format: 'rfc9457' })` so a validation
    // failure and a thrown error answer in the SAME shape. Asserted on the
    // booted app's bodies: both carry the Problem Details member set
    // (`type`/`title`/`status`/`detail`) and neither carries the pre-M56
    // default format's `message` field. If the template dropped the
    // `errorFormat` argument, the validation failure would answer in the
    // default shape (`message`/`errors`, no `type`/`title`/`status`/`detail`)
    // and this assertion fails.
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await nodeFs.writeFile(
      `${project}/src/controllers/index.ts`,
      `import { unauthorized } from '@setu-ts/exceptions';\n` +
        `import { validateQuery } from '@setu-ts/validation-plugin';\n` +
        `import type { IRouterApi } from '@setu-ts/common';\n\n` +
        `const nameRequired = {\n` +
        `  safeParse(_data: unknown) {\n` +
        `    return {\n` +
        `      success: false as const,\n` +
        `      error: { issues: [{ path: ['name'], message: 'name is required' }] },\n` +
        `    };\n` +
        `  },\n` +
        `};\n\n` +
        `export function registerGeneratedRoutes(router: IRouterApi): void {\n` +
        `  router.get('/validate', {\n` +
        `    middleware: [validateQuery(nameRequired)],\n` +
        `    handler: (ctx) => ctx.response.text('ok'),\n` +
        `  });\n` +
        `  router.get('/boom', () => {\n` +
        `    throw unauthorized('Token expired');\n` +
        `  });\n` +
        `}\n`,
    );

    const result = await bootWithGeneratedPermissions(project, ['/validate', '/boom']);

    expect(result.statuses['/validate'], result.output).toBe(400);
    expect(result.statuses['/boom'], result.output).toBe(401);

    const val = JSON.parse(result.bodies['/validate']) as Record<string, unknown>;
    const thr = JSON.parse(result.bodies['/boom']) as Record<string, unknown>;

    // Both are Problem Details: the same member set, and neither is the
    // default format (which carries `message` and `errors`).
    expect(val['type']).toBe('https://setu-ts.dev/errors/validation');
    expect(val['title']).toBe('Validation Error');
    expect(val['status']).toBe(400);
    expect(val['message']).toBeUndefined();
    expect(thr['type']).toBe('about:blank');
    expect(thr['title']).toBe('Unauthorized');
    expect(thr['status']).toBe(401);
    expect(thr['message']).toBeUndefined();
    // The two agree on the member set (C3): each carries type/title/status/
    // detail and no default-format `message`.
    for (const member of ['type', 'title', 'status', 'detail']) {
      expect(member in val, `validation body missing ${member}`).toBe(true);
      expect(member in thr, `thrown body missing ${member}`).toBe(true);
    }
  });
});

describe('a scaffolded project can install the versions it was pinned to', () => {
  /**
   * Rewrites the emitted manifest's dependency-age setting.
   *
   * @param project - The project directory
   * @param value - The value to set, or null to remove the key entirely
   */
  async function setDependencyAge(project: string, value: number | null): Promise<void> {
    const path = `${project}/deno.json`;
    const manifest = JSON.parse(await nodeFs.readFile(path, 'utf8')) as Record<string, unknown>;
    delete manifest['minimumDependencyAge'];
    delete manifest['//minimumDependencyAge'];
    if (value !== null) manifest['minimumDependencyAge'] = value;
    await nodeFs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await nodeFs.rm(`${project}/deno.lock`).catch(() => {});
  }

  it('installs under a policy that would otherwise refuse every version', async () => {
    // D1 only bites while the pinned version is inside the age window, so the
    // obvious test is reproducible for one day per release and vacuous after.
    // The overlay stamps the tree's own packs as published NOW, and the policy is
    // raised to ten years, which makes every version "too new" — reproducing the
    // refusal deterministically and forever. The scaffold's own
    // `minimumDependencyAge: 0` is then the only thing that can let the install
    // through. The pinned version is the tree's own, which the overlay always
    // serves, so a release bump can never deadlock this test against the
    // publish that would satisfy it.
    expect(await run(['new', 'shop', '--runtime', 'deno'])).toBe(0);
    const project = `${root}/shop`;

    // What the scaffold actually emitted, asserted here rather than only in the
    // unit test: the two legs below prove the VALUE has the effect, and this
    // line is what ties that to the value the CLI writes. Without it the test
    // would still pass if `setu new` emitted no key at all.
    const emitted = JSON.parse(await nodeFs.readFile(`${project}/deno.json`, 'utf8')) as {
      minimumDependencyAge?: unknown;
    };
    expect(emitted.minimumDependencyAge).toBe(0);
    expect(await nodeFs.readFile(`${project}/deno.json`, 'utf8')).toContain(
      'npm:@setu-ts/kernel@^',
    );

    const overlay = await startOverlay('now');
    try {
      const env = { NPM_CONFIG_REGISTRY: overlay.url };
      // 10 years in minutes. Without this leg the second one proves nothing: an
      // install that succeeds under a policy that was never going to refuse
      // anything is not evidence that the emitted key does the work.
      await setDependencyAge(project, 5_256_000);
      // The refusal is deterministic, but reaching it requires registry I/O to
      // resolve the versions first, so a transient blip under parallel load can
      // fail the install with a network error instead of the age message. The
      // retrying runner absorbs only that transient class.
      const refused = await denoRunRetry(project, ['install'], env);
      expect(refused.code, refused.output).toBe(1);
      expect(refused.output).toContain('minimum dependency age');

      // What the CLI actually emits. Expected to SUCCEED, through the retrying
      // runner, while a real refusal is still returned on its first attempt.
      await setDependencyAge(project, 0);
      const allowed = await denoRunRetry(project, ['install'], env);
      expect(allowed.code, allowed.output).toBe(0);
      expect(allowed.output).not.toContain('minimum dependency age');
    } finally {
      await overlay.close();
    }
  });
});

describe('a scaffolded full-stack project type-checks its own routes', () => {
  it('runs the generated check:app task over the app tree', async () => {
    expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'full-stack'])).toBe(0);
    const project = `${root}/shop`;

    // Against THIS workspace, not the published packages the scaffold pins.
    // Without it the emitted `app/` tree — which imports `@setu-ts/common` and
    // `@setu-ts/react-router-plugin` — is checked against a JSR snapshot, so the
    // gate cannot see drift from HEAD, and during a version bump it resolves a
    // version that is not published yet and blocks the release that would
    // publish it. That is the deadlock D1 describes.
    await useWorkspacePackages(project);

    // `deno install` after the repoint and before the check, and that ordering
    // is load-bearing: the app tree imports `@react-router/fs-routes` from npm,
    // so a check before the install fails on module resolution rather than on
    // anything the template emitted. Retrying, because this install is expected
    // to succeed and a transient registry blip under parallel load must not fail
    // the step.
    const installed = await denoRunRetry(project, ['install', '--allow-scripts']);
    expect(installed.code, installed.output).toBe(0);

    // The assertion D3 failed, with 79 `TS2686 'React' refers to a UMD global`
    // errors. `deno check main.ts` would NOT have caught it: the route modules
    // are loaded through the compiled server build, so the entry never reaches
    // them and only this glob does.
    const checked = await denoRun(project, ['task', 'check:app']);
    expect(checked.code, checked.output).toBe(0);
  });
});

/**
 * Collects the cookies a response set, as one `Cookie` request header value.
 *
 * @param response - The response carrying `Set-Cookie`
 * @returns The name=value pairs, joined
 */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

describe('a scaffolded full-stack project runs both middleware layers', () => {
  // A full-stack project has two middleware layers, and before this nothing ran
  // either one in that template: the seam probe boots every other host with a
  // generated middleware, but a full-stack project needs a real React Router build
  // first, and the scaffold shipped no route middleware at all. This drives both
  // through the generated project's own entry, under its own permissions.
  //
  // Skipped in CI at the maintainer's direction: the install, React Router
  // build and boot overran the 30 s test limit on a CI runner (PR #462) while
  // passing on a re-run. It still runs locally, with the same install/build budget
  // as the other full-stack integration proofs now that Tailwind and Radix are installed.
  it.skipIf(process.env['CI'] === 'true')(
    'applies kernel middleware to every request and route middleware to its route',
    { timeout: 900_000 },
    async () => {
      expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      // The kernel layer, exactly as a developer adds it.
      expect(await run(['g', 'middleware', 'audit', '--dir', project])).toBe(0);
      await useWorkspacePackages(project);

      const built = await runProcess(denoBinary(), {
        args: ['task', 'build'],
        cwd: project,
        stdout: 'piped',
        stderr: 'piped',
      });
      expect(built.code, new TextDecoder().decode(built.stderr)).toBe(0);

      const { result, output } = await withGeneratedServer(project, async (origin) => {
        // `manual`, so the route middleware's redirect is observed rather than followed.
        const get = (path: string, cookie?: string) =>
          fetch(`${origin}${path}`, {
            redirect: 'manual',
            ...(cookie === undefined ? {} : { headers: { cookie } }),
          });

        const health = await get('/health');
        await health.body?.cancel();
        const landing = await get('/');
        await landing.body?.cancel();
        const anonymous = await get('/products');
        await anonymous.body?.cancel();

        const loginPage = await get('/login');
        const token = /name="_csrf"\s+value="([^"]+)"/.exec(await loginPage.text())?.[1] ?? '';
        const submitted = await fetch(`${origin}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            cookie: cookiesOf(loginPage),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ _csrf: token, email: 'ada@example.com', password: 'x' }),
        });
        await submitted.body?.cancel();
        const signedIn = await get('/products', cookiesOf(submitted));

        return {
          audit: [health, landing, anonymous, signedIn].map((r) => r.headers.get('x-audit')),
          landing: landing.status,
          anonymous: { status: anonymous.status, location: anonymous.headers.get('location') },
          submitted: submitted.status,
          signedIn: { status: signedIn.status, body: await signedIn.text() },
        };
      });

      // Kernel layer: on a non-SSR route, an SSR page, a route-middleware redirect and
      // a rendered page alike — it wraps everything the application serves.
      expect(result.audit, output).toEqual(['true', 'true', 'true', 'true']);
      // Route layer: `/` shares the layout but is not guarded…
      expect(result.landing).toBe(200);
      // …while `/products` sends an anonymous visitor to sign in, before its loader runs.
      expect(result.anonymous).toEqual({ status: 302, location: '/login' });
      expect(result.submitted).toBe(302);
      // Signed in, the loader reads the user the route middleware put on the context.
      expect(result.signedIn.status).toBe(200);
      expect(result.signedIn.body).toContain('Signed in as');
      expect(result.signedIn.body).toContain('ada@example.com');
    },
  );
});

describe('a scaffolded full-stack project serves route edits in development', () => {
  // `deno task dev` runs Vite in-process. Before it existed, a route importing a
  // `@setu-ts` package answered 500 under Vite's dev SSR runner, which cannot
  // resolve a JSR import; and a package Vite loaded itself would have been a
  // second copy whose context keys matched nothing. This boots the generated
  // entry and edits a route while it runs.
  it(
    'renders through Vite, shares context keys, and serves an edit without a restart',
    { timeout: 900_000 },
    async () => {
      expect(await run(['new', '--runtime', 'deno', 'shop', '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      await useWorkspacePackages(project);
      const installed = await denoRunRetry(project, ['install', '--allow-scripts']);
      expect(installed.code, installed.output).toBe(0);

      const manifest = JSON.parse(await nodeFs.readFile(`${project}/deno.json`, 'utf8')) as {
        tasks: Record<string, string>;
      };
      expect(manifest.tasks['dev']).toBe('deno task install && deno run -A dev.ts');
      // `deno run` does not type-check, and the project's `check:app` does not
      // reach the entry, so check it here.
      const checked = await denoRunRetry(project, ['check', 'dev.ts']);
      expect(checked.code, checked.output).toBe(0);

      const port = await unusedPort();
      const vitePort = await unusedPort();
      // The task's own command after its install step, so the process killed
      // below is the server itself rather than a task runner wrapping it.
      const child = spawnProcess(denoBinary(), {
        args: ['run', '-A', 'dev.ts'],
        cwd: project,
        env: { PORT: String(port), VITE_PORT: String(vitePort) },
        stdout: 'piped',
        stderr: 'piped',
      });
      const origin = `http://127.0.0.1:${port}`;
      try {
        let served = false;
        for (let attempt = 0; attempt < 300 && !served; attempt++) {
          try {
            const response = await fetch(`${origin}/health`);
            await response.body?.cancel();
            served = response.ok;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        expect(served).toBe(true);

        // The login loader reads the CSRF token populateLoadContext set under a
        // contextKeyFor() key: a second module copy would leave it at its default.
        const login = await fetch(`${origin}/login`);
        const page = await login.text();
        expect(login.status, page).toBe(200);
        expect(page).toMatch(/name="_csrf"\s+value="[^"]+"/);

        // A client module, through the application's port.
        const module = /"(\/__vite\/app\/root\.tsx[^"]*)"/.exec(page)?.[1];
        expect(module).toBeDefined();
        const client = await fetch(`${origin}${module}`);
        await client.body?.cancel();
        expect(client.status).toBe(200);
        expect(client.headers.get('content-type')).toContain('javascript');

        const route = `${project}/app/routes/_auth/login.tsx`;
        const source = await nodeFs.readFile(route, 'utf8');
        expect(source).toContain('>Sign in<');
        await nodeFs.writeFile(route, source.replace('>Sign in<', '>Sign in, edited<'));
        let edited = '';
        for (let attempt = 0; attempt < 50 && !edited.includes('Sign in, edited'); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          edited = await (await fetch(`${origin}/login`)).text();
        }
        expect(edited).toContain('Sign in, edited');

        // SIGINT runs the entry's shutdown, which stops the app and Vite and exits 0.
        child.kill('SIGINT');
        const stopped = await child.status;
        expect(stopped.code).toBe(0);
      } finally {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited; its output is still drained below.
        }
        await child.status;
        await child.stdout!.cancel();
        await child.stderr!.cancel();
      }
    },
  );
});

/** M123: these assertions require built and booted output, rather than template text. */
describe('styled scaffolds (M123)', () => {
  for (const [target, template] of [
    ['node', 'rest'],
    ['bun', 'rest'],
    ['deno', 'rest'],
    ['node', 'class-based'],
  ] as const) {
    it(`builds and serves add view on ${target} ${template}`, { timeout: 900_000 }, async () => {
      expect(await run(['new', 'shop', '--runtime', target, '--template', template])).toBe(0);
      const project = `${root}/shop`;
      expect(await run(['add', 'view', '--dir', project])).toBe(0);
      const formatted =
        target === 'deno'
          ? await denoRun(project, ['fmt', '--check'])
          : await prettierCheck(project);
      expect(formatted.code, formatted.output).toBe(0);
      const overlay = await startOverlay();
      const execute = (args: string[]) =>
        runIn(project, target === 'node' ? 'npm' : target, args, overlay);
      const boot = (drive: (origin: string) => Promise<void>) =>
        target === 'deno' ? withGeneratedServer(project, drive) : withNodeServer(project, drive);
      try {
        const install = await execute(['install']);
        expect(install.code, install.output).toBe(0);
        const built = await execute([target === 'deno' ? 'task' : 'run', 'build']);
        expect(built.code, built.output).toBe(0);
        const checked = await execute([target === 'deno' ? 'task' : 'run', 'check']);
        expect(checked.code, checked.output).toBe(0);
        // The normal check reaches routes through setu.config.ts; assert the JSX path explicitly too.
        if (target === 'deno') {
          const views = await execute([
            'check',
            'src/views/home.tsx',
            'src/views/layout.tsx',
            'src/controllers/views.controller.ts',
          ]);
          expect(views.code, views.output).toBe(0);
        }
        await boot(async (origin) => {
          const page = await fetch(`${origin}/ui`);
          expect(page.status).toBe(200);
          const html = await page.text();
          expect(html).toContain('data-shell="frame"');
          expect(html).toContain('/assets/app.css');
          const css = await fetch(`${origin}/assets/app.css`);
          expect(css.status).toBe(200);
          expect(css.headers.get('content-type')).toContain('text/css');
          expect(await css.text()).toContain('.h-dvh');
        });
      } finally {
        await overlay.close();
      }
    });
  }
  for (const target of ['node', 'bun', 'deno', 'cloudflare-workers'] as const) {
    it(`builds full-stack token and shell CSS on ${target}`, { timeout: 900_000 }, async () => {
      expect(await run(['new', 'shop', '--runtime', target, '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      const formatted =
        target === 'deno'
          ? await denoRun(project, ['fmt', '--check'])
          : await prettierCheck(project);
      expect(formatted.code, formatted.output).toBe(0);
      const overlay = await startOverlay();
      const executable = target === 'node' || target === 'cloudflare-workers' ? 'npm' : target;
      try {
        const install = await runIn(
          project,
          executable,
          target === 'deno' ? ['task', 'install'] : ['install'],
          overlay,
        );
        expect(install.code, install.output).toBe(0);
        const built = await runIn(
          project,
          executable,
          [target === 'deno' ? 'task' : 'run', 'build'],
          overlay,
        );
        expect(built.code, built.output).toBe(0);
        if (target === 'node') {
          await nodeFs.mkdir(`${project}/.tmp`, { recursive: true });
          await nodeFs.writeFile(
            `${project}/.tmp/cn-probe.ts`,
            "import { cn } from 'cn';\nconsole.log(cn('p-2', false, 'p-6'));\n",
          );
          const merged = await runIn(project, 'node', ['--import', 'tsx', '.tmp/cn-probe.ts']);
          expect(merged.code, merged.output).toBe(0);
          expect(merged.output.trim()).toBe('p-6');
        }
        const assets = `${project}/build/client/assets`;
        const css = (
          await Promise.all(
            (await nodeFs.readdir(assets))
              .filter((name) => name.endsWith('.css'))
              .map((name) => nodeFs.readFile(`${assets}/${name}`, 'utf8')),
          )
        ).join('\n');
        expect(css).toContain('.h-dvh');
        expect(css).toContain('--primary:');
      } finally {
        await overlay.close();
      }
    });
  }
});

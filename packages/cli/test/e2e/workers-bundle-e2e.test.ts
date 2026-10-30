/**
 * M113d §3.5 — build and boot the CLI's own Workers templates.
 *
 * V9-1 reached users through these templates, and §3.4 bundles packages, not
 * projects: the generated entry, Vite's server build and `wrangler.toml` are
 * only exercised here. Every template is scaffolded against the registry
 * overlay (the M111d mechanism every Node e2e uses — the tree's own packed
 * tarballs, which is what npm serves after the cut), installed with plain
 * `npm install`, and bundled with `npx wrangler deploy --dry-run --outdir`,
 * which for `full-stack` runs the project's build through the `[build]`
 * stanza. Two projects are then booted under `wrangler dev`, on real
 * workerd — V9-23 and the full-stack startup failures are properties of
 * workerd, and no fake can show them:
 *
 * - `rest`, with `setu add database` and `setu add cloudflare` applied and a
 *   route behind `cacheApiMiddleware`, booted TWICE from one install: wired
 *   exactly as `setu add cloudflare` instructs (the `waitUntil` threading,
 *   §3.8), then as the bare `CloudflarePlugin({ env })` with no host — the V9-23
 *   reproduction, which only the hostless await (§3.6) makes cache a body. In
 *   both, `/` and `/health` answer 200 and the cached route answers its full
 *   body on a second request with `X-Cache-Api: HIT`.
 * - `full-stack`, pristine: `/` answers SSR HTML, `/health` reports `up`,
 *   and the client entry chunk under `/assets/` answers 200
 *   `text/javascript` (§3.10).
 *
 * The `rest` case follows the guidance `setu add` prints, word for word —
 * the printed registration plus the rename of the factory's `_waitUntil`
 * parameter — because `setu add` pins the package and prints the registration
 * rather than rewriting a non-starter configuration. Following it literally is
 * what proves the printed line compiles in the project it is printed for.
 *
 * Guarded like `workers-install-e2e`: skips without `npm` off CI, fails on
 * CI.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { delimiter } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { run as runProcess, tempDir, unusedPort } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { npmInstall, type RegistryOverlay, runIn, startOverlay } from '../fixtures/node-project.ts';

/** Whether `npm` can be spawned on this machine. */
async function npmAvailable(): Promise<boolean> {
  try {
    const { success } = await runProcess('npm', {
      args: ['--version'],
      stdout: 'null',
      stderr: 'null',
    });
    return success;
  } catch {
    return false;
  }
}

const onCi = process.env['CI'] === 'true';
const hasNpm = await npmAvailable();
const skip = !hasNpm && !onCi;

/**
 * A case scaffolds, installs, bundles and may boot a project, so it outlives
 * the suite's 30 s default by far.
 */
const CASE_TIMEOUT_MS = 900_000;

const runtime = createNodeRuntimeServices();

let overlay: RegistryOverlay;
let root = '';

beforeAll(async () => {
  overlay = await startOverlay();
}, CASE_TIMEOUT_MS);
afterAll(async () => {
  await overlay?.close();
});
beforeEach(async () => {
  root = await tempDir({ prefix: 'setu-workers-bundle-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
});

/** Runs the in-process CLI with the given working directory. */
async function run(args: readonly string[], cwd: string): Promise<number> {
  return await runCli(args, {
    fs: runtime.fs!,
    cwd,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

/**
 * Scaffolds one Workers template, installs it from the overlay, and hands
 * back the project directory.
 *
 * @param template - The template name
 * @returns The installed project directory
 */
async function scaffold(template: string): Promise<string> {
  expect(
    await run(['new', 'edge', '--template', template, '--runtime', 'cloudflare-workers'], root),
  ).toBe(0);
  const project = `${root}/edge`;
  const install = await npmInstall(project, overlay);
  expect(install.code, install.output).toBe(0);
  return project;
}

/**
 * Bundles a project the way a deploy would, without uploading: for
 * `full-stack` this runs the `[build]` stanza (the React Router server and
 * client builds) before the Worker bundle, which is the seam §3.10 exists
 * for.
 *
 * @param project - The installed project directory
 */
async function wranglerDryRun(project: string): Promise<void> {
  const { code, output } = await runIn(
    project,
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--outdir', '.wrangler-dry-run'],
    overlay,
  );
  expect({ code, tail: output.slice(-4000) }).toMatchObject({ code: 0 });
}

/** A running `npx wrangler dev`, killed as a whole process group. */
interface StartedDev {
  readonly status: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly output: () => string;
  signal(signal: NodeJS.Signals): void;
}

/**
 * Starts `npx wrangler dev` on an ephemeral port in a process group of its
 * own, since `npx` and `wrangler` each run the dev server in a child.
 *
 * @param project - The installed project directory
 * @param port - The port to serve on
 */
function startWranglerDev(project: string, port: number): StartedDev {
  const child = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${project}/node_modules/.bin${delimiter}${process.env['PATH'] ?? ''}`,
      NPM_CONFIG_REGISTRY: overlay.url,
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const status = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return {
    status,
    output: () => output,
    signal(signal) {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        // The group is already gone; its status and output remain.
      }
    },
  };
}

/** Polls `origin` until it answers, or gives up. */
async function waitForServer(origin: string, attempts = 900): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${origin}/`);
      await response.body?.cancel();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/**
 * Boots an installed project under `wrangler dev` and hands its origin to a
 * caller that drives it, then kills the process group.
 *
 * @param project - The installed project directory
 * @param drive - Called once the project is serving
 * @returns What `drive` returned, and everything the process wrote
 * @throws {Error} If the project never serves, or `drive` rejects
 */
async function withWranglerDev<T>(
  project: string,
  drive: (origin: string) => Promise<T>,
): Promise<{ readonly result: T; readonly output: string }> {
  const port = await unusedPort();
  const server = startWranglerDev(project, port);
  const origin = `http://127.0.0.1:${port}`;
  const served = await Promise.race([waitForServer(origin), server.status.then(() => false)]);
  let result: T | undefined;
  let failure: unknown;
  if (served) {
    try {
      result = await drive(origin);
    } catch (error) {
      failure = error;
    }
  }
  server.signal('SIGTERM');
  await server.status;
  if (!served) throw new Error(`wrangler dev never served ${origin}:\n${server.output()}`);
  if (failure !== undefined) throw failure;
  return { result: result!, output: server.output() };
}

/** How the `rest` case registers `CloudflarePlugin`. */
type CloudflareWiring = 'printed' | 'hostless';

/**
 * Wires the two `setu add`-ed plugins into the generated `rest`
 * configuration and puts one route behind `cacheApiMiddleware`.
 *
 * `printed` follows `setu add cloudflare` literally: the printed registration,
 * and the rename of the factory's `_waitUntil` parameter it names. `hostless`
 * registers `CloudflarePlugin({ env })`, the line 0.9.0 printed (V9-23).
 *
 * @param project - The scaffolded project directory
 * @param source - The generated configuration, before any wiring
 * @param wiring - Which registration to apply
 */
async function wireRestConfig(
  project: string,
  source: string,
  wiring: CloudflareWiring,
): Promise<void> {
  let out = source;

  const importAnchor = "import { OpenApiPlugin } from '@setu-ts/openapi-plugin';";
  expect(out, 'the generated config lost its OpenAPI import').toContain(importAnchor);
  out = out.replace(
    importAnchor,
    `${importAnchor}\nimport { DatabasePlugin } from '@setu-ts/database-plugin';\nimport { CloudflarePlugin, cacheApiMiddleware } from '@setu-ts/cloudflare-plugin';`,
  );

  const registration =
    wiring === 'printed'
      ? 'CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })'
      : 'CloudflarePlugin({ env })';
  if (wiring === 'printed') {
    const parameter = '_waitUntil?: (promise: Promise<unknown>) => void,';
    expect(out, 'the generated factory lost its _waitUntil parameter').toContain(parameter);
    out = out.replace(parameter, 'waitUntil?: (promise: Promise<unknown>) => void,');
  }

  const pluginAnchor = '...GENERATED_PLUGINS,';
  const anchorIndex = out.indexOf(pluginAnchor);
  expect(anchorIndex, 'the generated config lost its plugin anchor').toBeGreaterThanOrEqual(0);
  const lineStart = out.lastIndexOf('\n', anchorIndex) + 1;
  const indent = out.slice(lineStart, anchorIndex);
  out =
    out.slice(0, anchorIndex) +
    `DatabasePlugin({ type: 'memory' }),\n${indent}${registration},\n${indent}` +
    out.slice(anchorIndex);

  const routeRe =
    /^([ \t]*)app\.router\.get\('\/', \(ctx\) => ctx\.response\.json\(\{ message: 'Hello, World!' \}\)\);$/m;
  expect(out, 'the generated config lost its hello-world route').toMatch(routeRe);
  out = out.replace(
    routeRe,
    (_match, lead: string) =>
      `${lead}app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));\n` +
      `${lead}app.router.get('/cached', {\n` +
      `${lead}  handler: (ctx) => ctx.response.json({ message: 'cached-body', n: 1 }),\n` +
      `${lead}  // ttlSeconds gives the stored copy a Cache-Control, which the\n` +
      `${lead}  // platform's Cache API requires before a stored entry will match.\n` +
      `${lead}  middleware: [cacheApiMiddleware({ ttlSeconds: 300 })],\n` +
      `${lead}});`,
  );

  await nodeFs.writeFile(`${project}/setu.config.ts`, out);
}

/**
 * Boots the wired `rest` project and asserts `/`, `/health` and an edge-cache
 * HIT whose body is byte-identical to the MISS that stored it.
 *
 * @param project - The installed, wired project directory
 */
async function assertRestServesAndCaches(project: string): Promise<void> {
  const { result, output } = await withWranglerDev(project, async (origin) => {
    const home = await fetch(`${origin}/`);
    const homeBody = await home.text();
    const health = await fetch(`${origin}/health`);
    const healthBody = await health.text();
    const first = await fetch(`${origin}/cached`);
    const firstBody = await first.text();
    // With a host the write settles in the background, after the response;
    // a moment lets it land before the second request asks for the HIT.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await fetch(`${origin}/cached`);
    const secondBody = await second.text();
    return {
      homeStatus: home.status,
      homeBody,
      healthStatus: health.status,
      healthBody,
      firstHeader: first.headers.get('x-cache-api'),
      firstBody,
      secondStatus: second.status,
      secondHeader: second.headers.get('x-cache-api'),
      secondBody,
    };
  });

  expect(result.homeStatus, output).toBe(200);
  expect(result.homeBody, output).toContain('Hello, World!');
  expect(result.healthStatus, output).toBe(200);
  expect(result.healthBody, output).toContain('"status"');
  expect(result.firstHeader, output).toBe('MISS');
  expect(result.firstBody, output).toContain('cached-body');
  expect(result.secondStatus, output).toBe(200);
  expect(result.secondHeader, output).toBe('HIT');
  // The full body, replayed from the edge cache: byte-identical. V9-23 was an
  // empty body here, under a 200 and a HIT.
  expect(result.secondBody, output).toBe(result.firstBody);
}

describe("the CLI's Workers templates build and boot on workerd", () => {
  it(
    'generated feature module bundles and type-checks with its generated tests',
    { timeout: CASE_TIMEOUT_MS, skip },
    async () => {
      const project = await scaffold('rest');
      expect(await run(['generate', 'module', 'invoices', '--adopt-controllers'], project)).toBe(0);
      const files = await nodeFs.readdir(`${project}/src/modules/invoices`);
      // V10-23: Workers modules run under `tsx --test` like every other target,
      // so both test files are emitted and `tsc --noEmit` must accept them.
      expect(files).toContain('invoices.test.ts');
      expect(files).toContain('invoices.e2e.test.ts');
      expect(await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8')).toContain(
        'registerModules(app.router, app.services)',
      );
      const checked = await runIn(project, 'npm', ['run', 'check'], overlay);
      expect(checked.code, checked.output).toBe(0);
      await wranglerDryRun(project);
    },
  );

  for (const template of ['microservice', 'class-based'] as const) {
    it(
      `wrangler deploy --dry-run bundles --template ${template}`,
      {
        timeout: CASE_TIMEOUT_MS,
        skip,
      },
      async () => {
        const project = await scaffold(template);
        await wranglerDryRun(project);
      },
    );
  }

  it(
    'rest: setu add database + cloudflare, a route behind cacheApiMiddleware; wrangler dev serves /, /health and a HIT',
    {
      timeout: CASE_TIMEOUT_MS,
      skip,
    },
    async () => {
      const project = await scaffold('rest');
      expect(await run(['add', 'database'], project)).toBe(0);
      expect(await run(['add', 'cloudflare'], project)).toBe(0);
      const manifest = JSON.parse(await nodeFs.readFile(`${project}/package.json`, 'utf8')) as {
        dependencies: Record<string, string>;
      };
      expect(manifest.dependencies['@setu-ts/database-plugin']).toBeDefined();
      expect(manifest.dependencies['@setu-ts/cloudflare-plugin']).toBeDefined();
      // `setu add` pins the package and reports the install command rather than
      // spawning it, so the two pins need their own install before the bundle
      // can resolve them.
      const reinstall = await npmInstall(project, overlay);
      expect(reinstall.code, reinstall.output).toBe(0);
      const generated = await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8');

      await wireRestConfig(project, generated, 'printed');
      await wranglerDryRun(project);
      await assertRestServesAndCaches(project);

      // A fresh cache: wrangler dev persists `caches.default` under .wrangler,
      // and a HIT left by the first boot would satisfy the second.
      await nodeFs.rm(`${project}/.wrangler`, { recursive: true, force: true });
      await wireRestConfig(project, generated, 'hostless');
      await assertRestServesAndCaches(project);
    },
  );

  it(
    'full-stack: pristine, wrangler dev serves SSR HTML, /health and the client entry chunk',
    {
      timeout: CASE_TIMEOUT_MS,
      skip,
    },
    async () => {
      const project = await scaffold('full-stack');
      await wranglerDryRun(project);

      const { result, output } = await withWranglerDev(project, async (origin) => {
        const home = await fetch(`${origin}/`);
        const homeBody = await home.text();
        const health = await fetch(`${origin}/health`);
        const healthBody = await health.text();
        // The SSR document names the client entry chunk under /assets/ via a
        // modulepreload link (or a script src); the name is hashed, so read it
        // from the document rather than guess it.
        const asset =
          [...homeBody.matchAll(/href="\/assets\/[^"]+\.js"/g)].map((match) =>
            (match[0] as string).slice(6, -1),
          )[0] ??
          [...homeBody.matchAll(/src="\/assets\/[^"]+\.js"/g)].map((match) =>
            (match[0] as string).slice(5, -1),
          )[0];
        let assetStatus = 0;
        let assetType = '';
        if (asset !== undefined) {
          const chunk = await fetch(`${origin}${asset}`);
          assetStatus = chunk.status;
          assetType = chunk.headers.get('content-type') ?? '';
          await chunk.body?.cancel();
        }
        return {
          homeStatus: home.status,
          homeBody,
          healthStatus: health.status,
          healthBody,
          asset,
          assetStatus,
          assetType,
        };
      });

      expect(result.homeStatus, output).toBe(200);
      expect(result.homeBody, output).toContain('<html');
      expect(result.healthStatus, output).toBe(200);
      expect(result.healthBody, output).toContain('"status"');
      expect(result.asset, output).toBeDefined();
      expect(result.assetStatus, output).toBe(200);
      expect(result.assetType, output).toContain('text/javascript');
    },
  );
});

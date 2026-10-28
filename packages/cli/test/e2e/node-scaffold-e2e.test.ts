/**
 * The M63 gate on the Node default: a stock scaffold is installed with plain
 * `npm install`, passes its OWN `check`, `lint`, `format:check` and `test`
 * scripts, boots through its own `start` script, and serves what its README
 * advertises.
 *
 * Before M111d no e2e installed or ran a Node, Bun or Workers project at all,
 * while Node became the default target. Everything here runs through the
 * project's own scripts rather than a command the test composes, because a
 * script that cannot run is the defect a developer meets first.
 *
 * The framework installs from the local registry overlay — the tree's own
 * packed tarballs, which is exactly what npm will serve after the cut — and
 * every other package from the public registry through it.
 *
 * @module
 */
import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  installed,
  nodeBootAndSignal,
  npmInstall,
  npmRun,
  type RegistryOverlay,
  startOverlay,
  withNodeServer,
} from '../fixtures/node-project.ts';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/**
 * Every host on the Node default, and whether it boots. The no-template host
 * serves only `/`; a styled microservice is the decorator-and-DI composition of
 * the microservice recipe; one Workers host proves the npm tooling there too.
 */
const HOSTS: readonly (readonly [label: string, args: readonly string[], boots: boolean])[] = [
  ['no-template', [], true],
  ['rest', ['--template', 'rest'], true],
  ['microservice', ['--template', 'microservice'], true],
  ['class-based', ['--template', 'class-based'], true],
  ['full-stack', ['--template', 'full-stack'], true],
  ['microservice class-based', ['--template', 'microservice', '--style', 'class-based'], true],
  ['rest on workers', ['--template', 'rest', '--runtime', 'cloudflare-workers'], false],
];

/**
 * A case installs from the overlay, runs several project scripts and may build
 * a frontend before booting, so it outlives the suite's 30 s default by far.
 */
const INSTALL_TIMEOUT_MS = 600_000;

let overlay: RegistryOverlay;
let root = '';

beforeAll(async () => {
  overlay = await startOverlay();
}, 900_000);

afterAll(async () => {
  await overlay?.close();
});

beforeEach(async () => {
  root = await tempDir({ prefix: 'setu-node-scaffold-' });
});

afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
});

/** What one request served: enough to tell the advertised endpoint from a catch-all. */
interface Served {
  readonly status: number;
  /** The path the response finally came from, after any redirect. */
  readonly landed: string;
  readonly json: boolean;
  readonly body: string;
}

/** Fetches `path`, following redirects, and records what was served. */
async function fetchServed(origin: string, path: string): Promise<Served> {
  const response = await fetch(`${origin}${path}`);
  const body = await response.text();
  return {
    status: response.status,
    landed: new URL(response.url).pathname,
    json: (response.headers.get('content-type') ?? '').includes('json'),
    body,
  };
}

/**
 * The properties a path's response must carry, by what the README says it serves.
 * Each entry is something a fallthrough page (an SSR catch-all, a sign-in
 * redirect, the hello-world route) does NOT have.
 */
function expectedFor(path: string, host: string): Partial<Served> & Record<string, unknown> {
  const has = (needle: string) => ({ body: expect.stringContaining(needle) });
  switch (path) {
    case '/health':
    case '/live':
    case '/ready':
      return { status: 200, landed: path, json: true, ...has('"status"') };
    case '/metrics':
      return { status: 200, landed: path, ...has('# TYPE ') };
    case '/openapi.json':
      return { status: 200, landed: path, json: true, ...has('"openapi"') };
    case '/docs':
      return { status: 200, landed: path, ...has('swagger') };
    case '/greetings':
      return { status: 200, landed: path, json: true };
    case '/greetings/Setu':
      return { status: 200, landed: path, ...has('Setu') };
    case '/products':
      // Behind sign-in: it must redirect, and land on the sign-in form.
      return { status: 200, landed: '/login', ...has('<form') };
    case '/login':
      return { status: 200, landed: path, ...has('<form') };
    case '/':
      return host === 'full-stack'
        ? { status: 200, landed: path, ...has('<html') }
        : { status: 200, landed: path, json: true };
    default:
      throw new Error(`No expectation for advertised path ${path} — add one.`);
  }
}

/** Runs the CLI with the temp root as its working directory. */
async function run(args: readonly string[]): Promise<number> {
  return await runCli(args, {
    fs,
    cwd: root,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

/** The paths a generated README's "What it serves" section lists. */
async function advertisedPaths(project: string): Promise<string[]> {
  const readme = await nodeFs.readFile(`${project}/README.md`, 'utf8');
  const section = readme.split('## What it serves')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((match) =>
    (match[1] as string).replaceAll(/:[a-z]+/g, 'Setu'),
  );
}

/** Scaffolds and installs one host, failing with npm's output when it cannot. */
async function scaffoldAndInstall(args: readonly string[]): Promise<string> {
  expect(await run(['new', 'shop', ...args])).toBe(0);
  const project = `${root}/shop`;
  const install = await npmInstall(project, overlay);
  expect(install.code, install.output).toBe(0);
  return project;
}

describe('a scaffolded npm project runs its own scripts', () => {
  it(
    'builds a broken DI graph, then rejects it when npm test boots the application',
    { timeout: INSTALL_TIMEOUT_MS },
    async () => {
      const project = await scaffoldAndInstall(['--template', 'class-based']);
      const fresh = await npmRun(project, 'test');
      expect(fresh.code, fresh.output).toBe(0);
      await nodeFs.mkdir(`${project}/src/services`, { recursive: true });
      await nodeFs.writeFile(
        `${project}/src/services/broken.service.ts`,
        "import { Injectable, Inject } from '@setu-ts/decorator-plugin';\n@Injectable()\n@Inject('m120-missing-token')\nexport class BrokenService { constructor(readonly dependency: unknown) {} }\n",
      );
      expect(await run(['sync', '--dir', project])).toBe(0);
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      const tested = await npmRun(project, 'test');
      expect(tested.code, tested.output).not.toBe(0);
      expect(tested.output).toContain('ContainerValidationError');
      expect(tested.output).toContain('missing:');
      expect(tested.output).toContain('m120-missing-token');
    },
  );
  it(
    'fails its own check script for a copied, unregistered controller',
    { timeout: INSTALL_TIMEOUT_MS },
    async () => {
      const project = await scaffoldAndInstall(['--template', 'rest']);
      expect(await run(['generate', 'controller', 'original', '--dir', project])).toBe(0);
      expect((await npmRun(project, 'check')).code).toBe(0);
      const original = await nodeFs.readFile(
        `${project}/src/controllers/original.controller.ts`,
        'utf8',
      );
      await nodeFs.writeFile(
        `${project}/src/controllers/extra.controller.ts`,
        original.replaceAll('Original', 'Extra').replaceAll('original', 'extra'),
      );
      const result = await npmRun(project, 'check');
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('extra.controller.ts');
      expect(result.output).toContain('setu.E003');
    },
  );
  it('scaffolds Node when no target is named', { timeout: INSTALL_TIMEOUT_MS }, async () => {
    expect(await run(['new', 'shop'])).toBe(0);
    await nodeFs.stat(`${root}/shop/package.json`);
    await expect(nodeFs.stat(`${root}/shop/deno.json`)).rejects.toThrow();
  });

  for (const [label, args, boots] of HOSTS) {
    it(
      `installs, checks, lints, formats, tests${boots ? ' and serves' : ''}: ${label}`,
      {
        timeout: INSTALL_TIMEOUT_MS,
      },
      async () => {
        const project = await scaffoldAndInstall(args);

        // Every target carries generated tests: a socket target runs them in
        // process, a Workers target boots the real Worker on workerd (V10-23).
        // Only a socket target is then served on a local port.
        const scripts = ['check', 'lint', 'format:check', 'test', 'test:e2e'];
        const manifest = JSON.parse(await nodeFs.readFile(`${project}/package.json`, 'utf8')) as {
          scripts?: Record<string, string>;
        };
        expect(Object.keys(manifest.scripts ?? {})).toEqual(expect.arrayContaining(scripts));
        for (const script of scripts) {
          const result = await npmRun(project, script);
          expect({ script, code: result.code }, result.output).toEqual({ script, code: 0 });
        }
        if (!boots) return;
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);

        const advertised = await advertisedPaths(project);
        // Vacuity guard: every host lists at least `/`.
        expect(advertised.length, advertised.join(' ')).toBeGreaterThanOrEqual(1);
        const served: Record<string, Served> = {};
        const { output } = await withNodeServer(project, async (origin) => {
          for (const path of advertised) served[path] = await fetchServed(origin, path);
        });
        for (const path of advertised) {
          expect({ path, ...served[path] }, output).toEqual({
            path,
            ...served[path],
            ...expectedFor(path, label),
          });
        }
      },
    );
  }

  // Generated code is formatted with the project's own Prettier settings and
  // must compile, lint and serve like the scaffold it lands in. A class-based
  // module lists its service in `providers` and constructs it in its test, so a
  // type-only import there compiles nowhere and boots nowhere — the M111d
  // review found exactly that in output no Node gate had ever generated.
  for (const [style, args] of [
    ['class-based', ['--template', 'class-based']],
    ['functional', ['--template', 'rest']],
  ] as const) {
    it(
      `generates code that checks, lints, formats, tests and serves: ${style}`,
      {
        timeout: INSTALL_TIMEOUT_MS,
      },
      async () => {
        expect(await run(['new', 'shop', ...args])).toBe(0);
        const project = `${root}/shop`;
        for (const artifact of [
          ['module', 'widget'],
          ['service', 'billing'],
          ['middleware', 'audit'],
        ]) {
          expect(await run(['generate', ...artifact, '--dir', project]), artifact.join(' ')).toBe(
            0,
          );
        }
        const install = await npmInstall(project, overlay);
        expect(install.code, install.output).toBe(0);
        for (const script of ['check', 'lint', 'format:check', 'test', 'test:e2e']) {
          const result = await npmRun(project, script);
          expect({ script, code: result.code }, result.output).toEqual({ script, code: 0 });
        }
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);
        const { result, output } = await withNodeServer(
          project,
          async (origin) => await fetchServed(origin, '/widget'),
        );
        // The generated module's own list route answers the stub service's empty
        // list as JSON — not merely some 200 a catch-all could also return.
        expect(result, output).toEqual({
          ...result,
          status: 200,
          json: true,
          body: '{"items":[]}',
        });
      },
    );
  }

  // `--broker redis` declares the client its plugin loads: a package manager
  // never installs an optional peer for the consumer, so before M111d the first
  // boot failed at the plugin's own lazy import of `ioredis`.
  it('installs the client a selected broker loads', { timeout: INSTALL_TIMEOUT_MS }, async () => {
    const project = await scaffoldAndInstall(['--template', 'microservice', '--broker', 'redis']);
    expect(await installed(project, 'ioredis')).toBe(true);
    const checked = await npmRun(project, 'check');
    expect(checked.code, checked.output).toBe(0);
  });

  // The generated entry stops the application on SIGTERM through the runtime's
  // signal seam, so a container stop runs every shutdown hook instead of
  // killing the process mid-request.
  it('stops gracefully on SIGTERM', { timeout: INSTALL_TIMEOUT_MS }, async () => {
    const project = await scaffoldAndInstall(['--template', 'rest']);
    const outcome = await nodeBootAndSignal(project, 'SIGTERM');
    expect({ code: outcome.code, signal: outcome.signal }, outcome.output).toEqual({
      code: 0,
      signal: null,
    });
  });
});

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
  return [...section.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => (match[1] as string).replaceAll(/:[a-z]+/g, 'Setu'));
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
  it('scaffolds Node when no target is named', async () => {
    expect(await run(['new', 'shop'])).toBe(0);
    await nodeFs.stat(`${root}/shop/package.json`);
    await expect(nodeFs.stat(`${root}/shop/deno.json`)).rejects.toThrow();
  });

  for (const [label, args, boots] of HOSTS) {
    it(`installs, checks, lints, formats, tests${boots ? ' and serves' : ''}: ${label}`, async () => {
      const project = await scaffoldAndInstall(args);

      // A socket target carries a composition-root smoke test (M101g); a Workers
      // project serves no socket and carries none.
      const scripts = ['check', 'lint', 'format:check', ...(boots ? ['test'] : [])];
      const manifest = JSON.parse(await nodeFs.readFile(`${project}/package.json`, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(Object.keys(manifest.scripts ?? {})).toEqual(expect.arrayContaining(scripts));
      for (const script of scripts) {
        const result = await npmRun(project, script);
        expect({ script, code: result.code }, result.output).toEqual({ script, code: 0 });
      }
      if (!boots) return;

      const advertised = await advertisedPaths(project);
      // Vacuity guard: every host lists at least `/`.
      expect(advertised.length, advertised.join(' ')).toBeGreaterThanOrEqual(1);
      const statuses: Record<string, number> = {};
      const { output } = await withNodeServer(project, async (origin) => {
        for (const path of advertised) {
          const response = await fetch(`${origin}${path}`);
          statuses[path] = response.status;
          await response.body?.cancel();
        }
      });
      for (const path of advertised) {
        // `fetch` follows redirects, so a page behind sign-in lands on the
        // sign-in form and answers 200 as well.
        expect({ path, status: statuses[path] }, output).toEqual({ path, status: 200 });
      }
    });
  }

  // Generated code is formatted with the project's own Prettier settings and
  // must compile, lint and serve like the scaffold it lands in. A class-based
  // module lists its service in `providers` and constructs it in its test, so a
  // type-only import there compiles nowhere and boots nowhere — the M111d
  // review found exactly that in output no Node gate had ever generated.
  for (
    const [style, args] of [
      ['class-based', ['--template', 'class-based']],
      ['functional', ['--template', 'rest']],
    ] as const
  ) {
    it(`generates code that checks, lints, formats, tests and serves: ${style}`, async () => {
      expect(await run(['new', 'shop', ...args])).toBe(0);
      const project = `${root}/shop`;
      for (
        const artifact of [['module', 'widget'], ['service', 'billing'], ['middleware', 'audit']]
      ) {
        expect(await run(['generate', ...artifact, '--dir', project]), artifact.join(' ')).toBe(0);
      }
      const install = await npmInstall(project, overlay);
      expect(install.code, install.output).toBe(0);
      for (const script of ['check', 'lint', 'format:check', 'test']) {
        const result = await npmRun(project, script);
        expect({ script, code: result.code }, result.output).toEqual({ script, code: 0 });
      }
      const { result, output } = await withNodeServer(project, async (origin) => {
        const response = await fetch(`${origin}/widget`);
        await response.body?.cancel();
        return response.status;
      });
      expect(result, output).toBe(200);
    });
  }

  // `--broker redis` declares the client its plugin loads: a package manager
  // never installs an optional peer for the consumer, so before M111d the first
  // boot failed at the plugin's own `import('ioredis')`.
  it('installs the client a selected broker loads', async () => {
    const project = await scaffoldAndInstall(['--template', 'microservice', '--broker', 'redis']);
    expect(await installed(project, 'ioredis')).toBe(true);
    const checked = await npmRun(project, 'check');
    expect(checked.code, checked.output).toBe(0);
  });

  // The generated entry stops the application on SIGTERM through the runtime's
  // signal seam, so a container stop runs every shutdown hook instead of
  // killing the process mid-request.
  it('stops gracefully on SIGTERM', async () => {
    const project = await scaffoldAndInstall(['--template', 'rest']);
    const outcome = await nodeBootAndSignal(project, 'SIGTERM');
    expect({ code: outcome.code, signal: outcome.signal }, outcome.output).toEqual({
      code: 0,
      signal: null,
    });
  });
});

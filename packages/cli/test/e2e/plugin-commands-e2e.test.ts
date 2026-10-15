/**
 * A plugin-contributed command, discovered and run by the real `setu` binary
 * from a real installed project.
 *
 * Since M111d the CLI is a Node program, so it loads a project's
 * `setu.config.ts` through `tsx` and resolves the project's `@setu-ts/*`
 * imports from that project's `node_modules`. That is the path these cases
 * drive end to end, for both targets: an npm project after `npm install`, and a
 * Deno project after `deno install` (whose `nodeModulesDir: "auto"` creates the
 * `node_modules` the CLI reads). A Deno project NOT yet installed is refused by
 * name, with the command that fixes it, rather than failing deep in a resolver.
 *
 * @module
 */
import { denoBinary, tempDir } from '../../../../test/node-helpers.ts';
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import { npmInstall, type RegistryOverlay, runIn, startOverlay } from '../fixtures/node-project.ts';

const SETU = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

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
  root = await tempDir({ prefix: 'setu-plugin-commands-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
});

/** Runs the in-process CLI with the temp root as its working directory. */
async function run(args: readonly string[], cwd = root): Promise<number> {
  return await runCli(args, {
    fs: createNodeRuntimeServices().fs!,
    cwd,
    now: () => 0,
    log: () => {},
    error: () => {},
  });
}

/** Runs the `setu` binary on Node through `tsx`, inside a project. */
function setu(
  project: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = createRequire(import.meta.url).resolve('tsx/esm');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../../../../scripts/lib/source-register.ts', import.meta.url).href,
        '--import',
        pathToFileURL(tsx).href,
        SETU,
        ...args,
      ],
      { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Scaffolds a project whose generated plugin contributes `greet:hello`.
 *
 * @param runtime - The target to scaffold
 * @returns The project directory
 */
async function projectWithCommand(runtime: 'node' | 'deno'): Promise<string> {
  expect(await run(['new', 'shop', '--template', 'rest', '--runtime', runtime])).toBe(0);
  const project = `${root}/shop`;
  expect(await run(['generate', 'plugin', 'greet'], project)).toBe(0);
  const path = `${project}/src/plugins/greet.plugin.ts`;
  const source = await nodeFs.readFile(path, 'utf8');
  const registered = source.replace(
    'ctx.services.register(GREET, service);',
    "ctx.services.register(GREET, service);\n      ctx.cli.register('greet:hello', () => {\n        console.log('HELLO-FROM-PLUGIN');\n      });",
  );
  expect(registered).not.toBe(source);
  await nodeFs.writeFile(path, registered);
  return project;
}

describe('setu runs a plugin-contributed command', () => {
  it('from an installed Node project', { timeout: INSTALL_TIMEOUT_MS }, async () => {
    const project = await projectWithCommand('node');
    const install = await npmInstall(project, overlay);
    expect(install.code, install.output).toBe(0);

    const listed = await setu(project, ['commands']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('greet:hello');

    const ran = await setu(project, ['greet:hello']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('HELLO-FROM-PLUGIN');

    // Control: the project's framework is the INSTALLED tarball, not workspace
    // source. Poison the installed kernel's entry; a run that still redirected
    // the project's imports to source would keep passing.
    const entry = `${project}/node_modules/@setu-ts/kernel/dist/index.js`;
    // Prepended, so every export stays declared and linking succeeds; the
    // throw is what evaluating the installed copy does.
    const original = await nodeFs.readFile(entry, 'utf8');
    await nodeFs.writeFile(entry, `throw new Error('INSTALLED-KERNEL-LOADED');\n${original}`);
    const poisoned = await setu(project, ['greet:hello']);
    expect(poisoned.code).not.toBe(0);
    expect(poisoned.stderr + poisoned.stdout).toContain('INSTALLED-KERNEL-LOADED');
  });

  it(
    'from a Deno project once deno install has linked node_modules',
    {
      timeout: INSTALL_TIMEOUT_MS,
    },
    async () => {
      const project = await projectWithCommand('deno');

      // Not installed: the CLI cannot import the config from Node, and says how
      // to fix it instead of failing inside a resolver.
      const refused = await setu(project, ['greet:hello']);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('deno install');

      const install = await runIn(project, denoBinary(), ['install'], overlay);
      expect(install.code, install.output).toBe(0);
      const ran = await setu(project, ['greet:hello']);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toContain('HELLO-FROM-PLUGIN');
    },
  );
});

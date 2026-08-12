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

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  bootWithGeneratedPermissions,
  useWorkspacePackages,
} from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** Templates that wire an HTTP surface and boot without an npm build. */
const BOOTABLE = ['rest', 'microservice', 'nest'] as const;

/** Every host a scaffold can produce, including the no-template one. */
const HOSTS: readonly (readonly [label: string, args: readonly string[]])[] = [
  ['no-template', []],
  ['rest', ['--template', 'rest']],
  ['microservice', ['--template', 'microservice']],
  ['nest', ['--template', 'nest']],
  ['full-stack', ['--template', 'full-stack']],
];

let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-scaffold-runs-' });
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true }).catch(() => {});
});

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
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd: project,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const decoder = new TextDecoder();
  return { code, output: `${decoder.decode(stdout)}${decoder.decode(stderr)}` };
}

describe('a scaffolded project is formatted and lints clean', () => {
  for (const [label, args] of HOSTS) {
    it(`holds for ${label}`, async () => {
      expect(await run(['new', 'shop', ...args])).toBe(0);
      const project = `${root}/shop`;

      // The generated project carries its own `fmt` config; this asserts the
      // CLI's output already satisfies it, so a developer's first
      // `deno fmt` does not rewrite files they did not write.
      const formatted = await denoRun(project, ['fmt', '--check']);
      expect(formatted.code, formatted.output).toBe(0);

      const linted = await denoRun(project, ['lint']);
      expect(linted.code, linted.output).toBe(0);
    });
  }
});

describe('a scaffolded project serves its own advertised endpoints', () => {
  for (const template of BOOTABLE) {
    it(`holds for --template ${template}`, async () => {
      expect(await run(['new', 'shop', '--template', template])).toBe(0);
      const project = `${root}/shop`;
      await useWorkspacePackages(project);

      const result = await bootWithGeneratedPermissions(project, [
        '/health',
        '/ready',
        '/metrics',
      ]);

      // The assertion D2 failed: without `--allow-sys` the self indicator's
      // `runtime.hostname()` throws and the probe answers 500.
      expect(result.statuses['/health'], result.output).toBe(200);
      expect(result.statuses['/ready'], result.output).toBe(200);
      expect(result.statuses['/metrics'], result.output).toBe(200);

      // Not merely a 200: a health body reporting `down` would also be a 200
      // shaped failure on some configurations.
      expect(result.bodies['/health']).toContain('"status":"up"');
    });
  }
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
    const manifest = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
    delete manifest['minimumDependencyAge'];
    delete manifest['//minimumDependencyAge'];
    if (value !== null) manifest['minimumDependencyAge'] = value;
    await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await Deno.remove(`${project}/deno.lock`).catch(() => {});
  }

  it('installs under a policy that would otherwise refuse every version', async () => {
    // D1 only bites while the pinned version is inside the age window, so the
    // obvious test is reproducible for one day per release and vacuous after.
    // Raising the threshold instead makes EVERY published version "too new",
    // which reproduces the same refusal deterministically and forever — the
    // scaffold's own `minimumDependencyAge: 0` is then the only thing that can
    // let the install through.
    expect(await run(['new', 'shop'])).toBe(0);
    const project = `${root}/shop`;

    // What the scaffold actually emitted, asserted here rather than only in the
    // unit test: the two legs below prove the VALUE has the effect, and this
    // line is what ties that to the value the CLI writes. Without it the test
    // would still pass if `setu new` emitted no key at all.
    const emitted = JSON.parse(await Deno.readTextFile(`${project}/deno.json`)) as {
      minimumDependencyAge?: unknown;
    };
    expect(emitted.minimumDependencyAge).toBe(0);

    // 10 years in minutes. Without this leg the second one proves nothing: an
    // install that succeeds under a policy that was never going to refuse
    // anything is not evidence that the emitted key does the work.
    await setDependencyAge(project, 5_256_000);
    const refused = await denoRun(project, ['install']);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('minimum dependency age');

    // What the CLI actually emits.
    await setDependencyAge(project, 0);
    const allowed = await denoRun(project, ['install']);
    expect(allowed.code, allowed.output).toBe(0);
    expect(allowed.output).not.toContain('minimum dependency age');
  });
});

describe('a scaffolded full-stack project type-checks its own routes', () => {
  it('runs the generated check:app task over the app tree', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
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
    // anything the template emitted.
    const installed = await denoRun(project, ['install', '--allow-scripts']);
    expect(installed.code, installed.output).toBe(0);

    // The assertion D3 failed, with 79 `TS2686 'React' refers to a UMD global`
    // errors. `deno check main.ts` would NOT have caught it: the route modules
    // are loaded through the compiled server build, so the entry never reaches
    // them and only this glob does.
    const checked = await denoRun(project, ['task', 'check:app']);
    expect(checked.code, checked.output).toBe(0);
  });
});

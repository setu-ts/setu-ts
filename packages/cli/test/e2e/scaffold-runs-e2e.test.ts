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
const BOOTABLE = ['rest', 'microservice', 'class-based'] as const;

/** Every host a scaffold can produce, including the no-template one. */
const HOSTS: readonly (readonly [label: string, args: readonly string[]])[] = [
  ['no-template', []],
  ['rest', ['--template', 'rest']],
  ['microservice', ['--template', 'microservice']],
  ['class-based', ['--template', 'class-based']],
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

describe('a scaffolded project configures itself from a dotenv file', () => {
  it('emits an ignored dotenv file beside a tracked example', async () => {
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;

    expect((await Deno.stat(`${project}/.env`)).isFile).toBe(true);
    expect((await Deno.stat(`${project}/.env.example`)).isFile).toBe(true);
    // The example is the committed one, so the ignore rule must name only the
    // real file — an ignore of `.env*` would take the example with it.
    const gitignore = await Deno.readTextFile(`${project}/.gitignore`);
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
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await Deno.remove(`${project}/.env`);

    const result = await bootWithGeneratedPermissions(project, ['/health']);

    expect(result.statuses['/health'], result.output).toBe(200);
  });

  it('reads values from the dotenv file it emitted', async () => {
    // The other half: tolerating absence must not mean ignoring the file. This
    // asserts the configured path is genuinely loaded, so a fix that silently
    // stopped reading dotenv files would fail here rather than pass both ways.
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await Deno.writeTextFile(`${project}/.env`, 'SCAFFOLD_PROBE_VALUE=from-dotenv\n');
    await Deno.writeTextFile(
      `${project}/src/routes/index.ts`,
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
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await Deno.writeTextFile(
      `${project}/src/routes/index.ts`,
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

  /**
   * Relaxes the scaffold's `@setu-ts/*` pins to the range floor.
   *
   * Both legs below are REAL registry installs — that is the point, since a
   * workspace-repointed project never consults JSR and so can never exercise
   * the age policy. But `setu new` pins a project to the CLI's OWN version,
   * which during a release bump is not published yet, so the install fails on
   * `Could not find version … that matches '^<next>'` before any age policy is
   * consulted: the test would then block the very release that would publish
   * the version it wants. `^0.1.0-alpha.1` resolves to the newest published
   * release (measured: alpha.7 while alpha.8 was unpublished), so it needs no
   * maintenance, and it changes nothing either leg proves — the emitted value
   * is asserted separately above, and every published version is younger than
   * the ten-year threshold that makes the refusal leg deterministic.
   *
   * @param project - The project directory
   */
  async function relaxFrameworkPins(project: string): Promise<void> {
    const path = `${project}/deno.json`;
    const source = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      source.replaceAll(/(@setu-ts\/[a-z-]+)@\^[^"]+/g, '$1@^0.1.0-alpha.1'),
    );
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

    // Read the emitted pins BEFORE relaxing them, so this leg still fails if
    // `setu new` ever stops pinning the framework at all.
    expect(await Deno.readTextFile(`${project}/deno.json`)).toContain('jsr:@setu-ts/kernel@^');
    await relaxFrameworkPins(project);

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

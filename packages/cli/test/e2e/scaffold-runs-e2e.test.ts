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
  bootAndProbe,
  bootWithGeneratedPermissions,
  useWorkspacePackages,
} from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** Templates that wire an HTTP surface and boot without an npm build. */
// X5-3's fix and its gate are the same change: `full-stack` was excluded from
// this list because it could not boot — it had no `build` task, so `deno task
// start` died on a missing server build. The one template that could not boot
// was the one the boot gate skipped. It now emits `install`/`build` and `start`
// depends on `build`, so it belongs here.
const BOOTABLE = ['rest', 'microservice', 'class-based', 'full-stack'] as const;

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
  [
    'microservice on workers',
    ['--template', 'microservice', '--runtime', 'cloudflare-workers'],
  ],
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
): Promise<{ code: number; output: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd: project,
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

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
): Promise<{ code: number; output: string }> {
  let result = await runDenoOnce(project, args);
  for (let attempt = 1; attempt < DENO_INSTALL_ATTEMPTS; attempt++) {
    if (result.code === 0 || !isTransientInstallFailure(result.output)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, DENO_INSTALL_RETRY_DELAY_MS));
    result = await runDenoOnce(project, args);
  }
  return result;
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

  for (const template of BOOTABLE) {
    it(`holds for --template ${template}`, async () => {
      expect(await run(['new', 'shop', '--template', template])).toBe(0);
      const project = `${root}/shop`;
      await useWorkspacePackages(project);

      // `full-stack` builds its React Router server before it can serve, and
      // `start` depends on `build` — which is exactly what X5-3 added. Running
      // the task here rather than letting `start` do it keeps the boot's own
      // timeout measuring the boot.
      if (template === 'full-stack') {
        const built = await new Deno.Command(Deno.execPath(), {
          args: ['task', 'build'],
          cwd: project,
          stdout: 'piped',
          stderr: 'piped',
        }).output();
        expect(built.code, new TextDecoder().decode(built.stderr)).toBe(0);
      }

      const paths = [
        '/health',
        '/ready',
        '/metrics',
        ...(template === 'rest' ? ['/greetings', '/greetings/Setu'] : []),
      ];
      const result = await bootWithGeneratedPermissions(project, paths);

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
    });
  }
});

describe('a scaffolded Workers project retries a failed boot and never leaks the stack', () => {
  // X9-8: `booted ??= boot(env)` cached the raw promise, so ONE failed boot was
  // permanent for the isolate's life AND the raw error reached the client. The
  // generated entry must answer a generic 503 while reporting to the platform
  // logs, and a later request must re-attempt boot.
  it('answers 503 without the stack, and the next request re-attempts boot', async () => {
    expect(await run(['new', 'shop', '--template', 'rest', '--runtime', 'cloudflare-workers']))
      .toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);

    // A config whose FIRST construction fails with an error carrying a path
    // marker — under the old memoisation both requests would replay this
    // failure and the message would leak into the response body.
    await Deno.writeTextFile(
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
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await Deno.writeTextFile(
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
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    await useWorkspacePackages(project);
    await Deno.writeTextFile(
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
   * the version it wants. `^0.1.0-alpha.1` resolves to a published release, so
   * it does not deadlock, and it changes nothing either leg proves — the
   * emitted value is asserted separately above, and every published version is
   * younger than the ten-year threshold that makes the refusal leg
   * deterministic.
   *
   * It no longer tracks the NEWEST published release, which it did while every
   * version was a `0.1.0-alpha.N` prerelease: a caret range caps at the next
   * minor, so from `v0.2.0` onward this deliberately installs the newest
   * release of the alpha line. That is still a real registry install under a
   * real age policy, which is all either leg needs. The self-maintaining
   * alternative is a BARE specifier — unavailable before `v0.2.0`, because JSR
   * never pointed `latest` at a prerelease, and available now.
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
    // The refusal is deterministic, but reaching it requires registry I/O to
    // resolve the versions first, so a transient blip under parallel load can
    // fail the install with a network error instead of the age message. The
    // retrying runner absorbs only that transient class and returns the
    // deterministic refusal (or a success, which would expose a real defect)
    // on its first attempt.
    const refused = await denoRunRetry(project, ['install']);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('minimum dependency age');

    // What the CLI actually emits. This install is expected to SUCCEED, so it
    // goes through the retrying runner: a transient registry blip under the
    // full suite's parallel load must not fail the step, while a real refusal
    // (which is deterministic) is still returned on its first attempt.
    await setDependencyAge(project, 0);
    const allowed = await denoRunRetry(project, ['install']);
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

/**
 * The e2e bar for the standalone broker flags (M72): a `--broker`/`--queue`
 * scaffold is formatted, linted, type-checked against this workspace, and —
 * where a real broker backs it — BOOTED and asked for `/health`.
 *
 * The type-check half is deliberately UNGUARDED: `Wiring.args` is a rendered
 * STRING, invisible to the CLI's own `deno check`, so a malformed literal is a
 * compile error only in the GENERATED project — the M50b trap. The boot half is
 * guarded on `REDIS_URL`, which CI's job-level env sets against a real
 * `redis:7` service container; locally without a broker it skips rather than
 * failing on a connection the machine never promised.
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
  collectSources,
  denoCheck,
  useWorkspacePackages,
} from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** Whether a real broker backs the boot half: CI sets this at job level. */
const REDIS_AVAILABLE = Deno.env.get('REDIS_URL') !== undefined;

let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-broker-scaffold-' });
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
  const command = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd: project,
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    output: `${new TextDecoder().decode(stdout)}${new TextDecoder().decode(stderr)}`,
  };
}

describe('a --broker redis --queue redis scaffold', () => {
  it('renders a config that differs from the default one', async () => {
    await run(['new', 'plain', '--template', 'microservice']);
    expect(
      await run([
        'new',
        'svc',
        '--template',
        'microservice',
        '--broker',
        'redis',
        '--queue',
        'redis',
      ]),
    ).toBe(0);

    const plain = await Deno.readTextFile(`${root}/plain/setu.config.ts`);
    const brokered = await Deno.readTextFile(`${root}/svc/setu.config.ts`);
    expect(brokered).not.toBe(plain);
    expect(plain).toContain('MessagingPlugin()');
    expect(brokered).toContain("broker: 'redis-streams'");
    expect(brokered).toContain("adapter: 'redis'");
    // The dotenv pair names the variable; the Compose file starts the broker.
    expect(await Deno.readTextFile(`${root}/svc/.env`)).toContain('REDIS_URL=');
    expect(await Deno.readTextFile(`${root}/svc/docker/compose.yaml`)).toContain('image: redis:7');
  });

  it('is formatted, lints clean, and type-checks against this workspace', async () => {
    expect(
      await run([
        'new',
        'svc',
        '--template',
        'microservice',
        '--broker',
        'redis',
        '--queue',
        'redis',
      ]),
    ).toBe(0);
    const project = `${root}/svc`;
    await useWorkspacePackages(project);

    const formatted = await denoRun(project, ['fmt', '--check']);
    expect(formatted.code, formatted.output).toBe(0);
    const linted = await denoRun(project, ['lint']);
    expect(linted.code, linted.output).toBe(0);
    const checked = await denoCheck(project, await collectSources(project));
    expect(checked.code, checked.stderr).toBe(0);
  });

  // KAFKA specifically, because it is the ONE arm that nests the connection
  // inside a bracket (`brokers: [...]`). `envRead` bakes a fixed continuation
  // indent suited to a value at eight spaces, so the unshifted form made this
  // scaffold fail its OWN `deno fmt --check` — the M63 bar, and invisible to
  // every other arm. Reverting `nestConnection` fails exactly this case.
  it('emits a --broker kafka scaffold that passes its own deno fmt --check', async () => {
    expect(await run(['new', 'kf', '--template', 'microservice', '--broker', 'kafka'])).toBe(0);
    const project = `${root}/kf`;
    await useWorkspacePackages(project);

    const formatted = await denoRun(project, ['fmt', '--check']);
    expect(formatted.code, formatted.output).toBe(0);
    const checked = await denoCheck(project, await collectSources(project));
    expect(checked.code, checked.stderr).toBe(0);
  });

  it('type-checks a --broker rabbitmq scaffold too', async () => {
    expect(await run(['new', 'mq', '--template', 'microservice', '--broker', 'rabbitmq'])).toBe(0);
    const project = `${root}/mq`;
    await useWorkspacePackages(project);
    const checked = await denoCheck(project, await collectSources(project));
    expect(checked.code, checked.stderr).toBe(0);
  });

  // Guarded, not skipped silently: CI sets REDIS_URL at job level against a
  // real redis:7 service container, so the boot half runs there every time.
  // Locally without a broker it reports `ignored` with its reason, never a
  // false pass.
  it({
    name: 'boots under its own permissions and answers /health once the broker runs',
    ignore: !REDIS_AVAILABLE,
    fn: async () => {
      expect(
        await run([
          'new',
          'svc',
          '--template',
          'microservice',
          '--broker',
          'redis',
          '--queue',
          'redis',
        ]),
      ).toBe(0);
      const project = `${root}/svc`;
      await useWorkspacePackages(project);
      const outcome = await bootWithGeneratedPermissions(project, ['/health']);
      expect(outcome.statuses['/health'], outcome.output).toBe(200);
    },
  });
});

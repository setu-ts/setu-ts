/**
 * The graceful-shutdown gate: scaffolds a project, boots it, and stops it the way
 * a container runtime does.
 *
 * This exists because the generated entry used to install no signal handler at
 * all, and no other check could see it. `deno check` compiles an entry that
 * ignores `SIGTERM` exactly as happily as one that handles it, the unit
 * assertions read the emitted source rather than run it, and every other e2e in
 * this package stops its subprocess with `SIGKILL` or lets it exit on its own —
 * so nothing ever took the path a `docker stop` or a pod eviction takes.
 *
 * Measured before the fix: a scaffolded project died with **exit code 143,
 * killed by the signal**, having run neither `onStopping` nor `onShutdown`. That
 * is a service that never deregisters from discovery and a database that never
 * disconnects, on every deploy.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { bootAndSignal, useWorkspacePackages } from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/**
 * A plugin that reports each shutdown phase as it runs.
 *
 * Written into `src/plugins/index.ts`, the CLI-managed barrel the generated
 * `setu.config.ts` already spreads into `createApplication({ plugins })` — so the
 * probe reaches the application through the seam the CLI itself emits, and no
 * file the renderer owns has to be rewritten by string surgery.
 *
 * The hooks matter more than the exit code: a process could exit `0` for reasons
 * unrelated to shutdown, but these two lines can only appear if `app.stop()` ran.
 */
const SHUTDOWN_PROBE_BARREL = `import type { IPlugin, IPluginContext } from '@setu-ts/common';

export const GENERATED_PLUGINS: readonly IPlugin[] = [{
  name: 'shutdown-probe',
  version: '0.1.0',
  register(ctx: IPluginContext): void {
    ctx.lifecycle.onStopping(() => {
      console.log('PROBE onStopping');
    });
    ctx.lifecycle.onShutdown(() => {
      console.log('PROBE onShutdown');
    });
  },
}];
`;

describe('generated entry — graceful shutdown', () => {
  let root: string;
  const logs: string[] = [];

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-shutdown-' });
    logs.length = 0;
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /**
   * Runs the CLI against the temporary directory.
   *
   * @param argv - Arguments after the program name
   * @returns The exit code
   */
  async function run(argv: readonly string[]): Promise<number> {
    return await runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`runs the shutdown hooks and exits 0 on ${signal}`, async () => {
      expect(await run(['new', 'svc'])).toBe(0);
      const project = `${root}/svc`;
      await useWorkspacePackages(project);
      await Deno.writeTextFile(`${project}/src/plugins/index.ts`, SHUTDOWN_PROBE_BARREL);

      const outcome = await bootAndSignal(project, signal);

      // Death by signal is what an unhandled SIGTERM looks like, and `143` is
      // the code it produces. Asserting both ways round means a future entry
      // that catches the signal and then hard-exits still fails this.
      expect(outcome.killedBySignal).toBeNull();
      expect(outcome.code).toBe(0);
      expect(outcome.output).toContain('PROBE onStopping');
      expect(outcome.output).toContain('PROBE onShutdown');
    });
  }
});

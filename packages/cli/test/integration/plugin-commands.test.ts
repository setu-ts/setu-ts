/**
 * Drives discovery against a REAL kernel application carrying a REAL plugin
 * that registers commands through the committed `ICliApi`.
 *
 * The unit tests use a fake `IApplication`; this proves the assumptions that
 * fake encodes are true of the kernel: that `ctx.cli.register` lands under
 * `CAPABILITIES.CLI_COMMAND` as `{ name, handler }`, that `start()` with no
 * port binds no socket, and that `stop()` is safe afterwards.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import type { IApplication, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { dispatchPluginCommand, runCommandsListing } from '../../src/commands/plugin-commands.ts';

/** Records what each registered handler received. */
const calls: string[] = [];

/**
 * A plugin that publishes CLI commands the way a real one would.
 *
 * @param name - Plugin name, so several can coexist
 * @param commands - Command names to register
 * @returns The plugin
 */
function commandPlugin(name: string, commands: readonly string[]): IPlugin {
  return {
    name,
    version: '0.1.0',
    register(ctx: IPluginContext): void {
      for (const command of commands) {
        ctx.cli.register(command, (args) => {
          calls.push(`${command}(${args.join(',')})`);
        });
      }
    },
  };
}

/**
 * Builds a real kernel application and the dependency bundle that loads it.
 *
 * @param plugins - Plugins to register alongside the runtime provider
 * @returns The dependencies plus the output recorders
 */
function realAppDeps(plugins: readonly IPlugin[]) {
  const out = createRecorder();
  const err = createRecorder();
  let app: IApplication | undefined;
  return {
    out,
    err,
    getApp: () => app,
    deps: {
      fs: createFakeFs({ '/proj/honoe.config.ts': 'export function createApp() {}' }),
      cwd: '/proj',
      log: out.sink,
      error: err.sink,
      // The seam returns a module whose factory builds a REAL application.
      loadApp: () =>
        Promise.resolve({
          createApp: () => {
            app = createApplication({ plugins: [RuntimePlugin(), ...plugins] });
            return app;
          },
        }),
    },
  };
}

describe('plugin commands against a real kernel application', () => {
  it('discovers commands a real plugin registered through ctx.cli.register', async () => {
    const { deps, out } = realAppDeps([commandPlugin('db', ['db:migrate', 'db:seed'])]);
    expect(await runCommandsListing(parseArgs([]), deps)).toBe(0);
    expect(out.text()).toContain('db:migrate');
    expect(out.text()).toContain('db:seed');
  });

  it('runs a real handler with the trailing positionals', async () => {
    calls.length = 0;
    const { deps } = realAppDeps([commandPlugin('db', ['db:migrate'])]);
    expect(await dispatchPluginCommand('db:migrate', parseArgs(['up', '3']), deps)).toBe(0);
    expect(calls).toEqual(['db:migrate(up,3)']);
  });

  it('binds no socket, so repeated discovery never collides or leaks', async () => {
    // Deno's test resource sanitizer fails the test if a listener were left
    // open, so a clean pass here IS the no-socket evidence. Running twice adds
    // the collision check a single run cannot make.
    for (let i = 0; i < 2; i++) {
      const { deps, out } = realAppDeps([commandPlugin('db', ['db:migrate'])]);
      expect(await runCommandsListing(parseArgs([]), deps)).toBe(0);
      expect(out.text()).toContain('db:migrate');
    }
  });

  it('completes the full startup sequence, minus the listen', async () => {
    // Commands only reach the registry if every plugin's register() ran, so a
    // populated listing proves startup completed without a port.
    const { deps, getApp, out } = realAppDeps([commandPlugin('db', ['db:migrate'])]);
    await runCommandsListing(parseArgs([]), deps);
    expect(out.text()).toContain('db:migrate');
    // Post-teardown the app still answers rather than throwing: the handler was
    // installed by start(), which is the non-listen half of the sequence.
    const response = await getApp()!.fetch(new Request('http://localhost/'));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('stops the real application, so the process is not held open', async () => {
    const { deps, getApp } = realAppDeps([commandPlugin('db', ['db:migrate'])]);
    await dispatchPluginCommand('db:migrate', parseArgs([]), deps);
    // stop() is idempotent; a second call must not throw after teardown.
    await expect(getApp()!.stop()).resolves.toBeUndefined();
  });

  it('reports an unknown command against the real registry', async () => {
    const { deps, err } = realAppDeps([commandPlugin('db', ['db:migrate'])]);
    expect(await dispatchPluginCommand('db:rollback', parseArgs([]), deps)).toBe(2);
    expect(err.text()).toContain('db:migrate');
  });

  it('refuses when two real plugins register the same command name', async () => {
    calls.length = 0;
    const { deps, err } = realAppDeps([
      commandPlugin('db', ['db:migrate']),
      commandPlugin('legacy-db', ['db:migrate']),
    ]);
    expect(await dispatchPluginCommand('db:migrate', parseArgs([]), deps)).toBe(1);
    expect(err.text()).toContain('registered 2 times');
    expect(calls).toEqual([]);
  });

  it('exits 0 for an application whose plugins register nothing', async () => {
    const { deps, out } = realAppDeps([]);
    expect(await runCommandsListing(parseArgs([]), deps)).toBe(0);
    expect(out.text()).toContain('No plugin commands are registered');
  });

  it('surfaces a real startup failure as exit 1', async () => {
    const out = createRecorder();
    const err = createRecorder();
    const code = await runCommandsListing(parseArgs([]), {
      fs: createFakeFs({ '/proj/honoe.config.ts': 'x' }),
      cwd: '/proj',
      log: out.sink,
      error: err.sink,
      // No RuntimePlugin: the kernel makes the runtime capability mandatory.
      loadApp: () => Promise.resolve({ createApp: () => createApplication({ plugins: [] }) }),
    });
    expect(code).toBe(1);
    expect(err.text().toLowerCase()).toContain('runtime');
  });
});

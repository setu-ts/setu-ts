import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { createFakeApp, type FakeApp, type FakeCommand } from '../fixtures/fake-app.ts';
import { parseArgs } from '../../src/args.ts';
import { dispatchPluginCommand, runCommandsListing } from '../../src/commands/plugin-commands.ts';

const CONFIG = '/app/honoe.config.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  readonly app: FakeApp;
  list(argv?: readonly string[]): Promise<number>;
  dispatch(name: string, argv?: readonly string[]): Promise<number>;
}

/**
 * Builds a harness whose project has a config module exporting the given app.
 */
function harness(
  app: FakeApp = createFakeApp(),
  options: { readonly withConfig?: boolean; readonly loadFails?: string } = {},
): Harness {
  const fs = createFakeFs(
    options.withConfig === false ? {} : { [CONFIG]: 'export function createApp() {}' },
  );
  const out = createRecorder();
  const err = createRecorder();
  const deps = {
    fs,
    cwd: '/app',
    log: out.sink,
    error: err.sink,
    loadApp: (_url: string) =>
      options.loadFails === undefined
        ? Promise.resolve({ createApp: () => app })
        : Promise.reject(new Error(options.loadFails)),
  };
  return {
    fs,
    out,
    err,
    app,
    list: (argv = []) => runCommandsListing(parseArgs(argv), deps),
    dispatch: (name, argv = []) => dispatchPluginCommand(name, parseArgs(argv), deps),
  };
}

const noop: FakeCommand['handler'] = () => {};

describe('runCommandsListing', () => {
  it('lists the registered commands and exits 0', async () => {
    const h = harness(createFakeApp([
      { name: 'db:migrate', handler: noop },
      { name: 'cache:clear', handler: noop },
    ]));
    expect(await h.list()).toBe(0);
    expect(h.out.text()).toContain('honoe cache:clear');
    expect(h.out.text()).toContain('honoe db:migrate');
  });

  it('sorts the listing so output is stable', async () => {
    const h = harness(createFakeApp([
      { name: 'z:last', handler: noop },
      { name: 'a:first', handler: noop },
    ]));
    await h.list();
    expect(h.out.text().indexOf('a:first')).toBeLessThan(h.out.text().indexOf('z:last'));
  });

  it('exits 0 with an explanation when nothing is registered', async () => {
    const h = harness(createFakeApp([]));
    expect(await h.list()).toBe(0);
    expect(h.out.text()).toContain('No plugin commands are registered');
    expect(h.out.text()).toContain('ctx.cli.register');
  });

  it('exits 2 naming honoe.config.ts when the project has none', async () => {
    const h = harness(createFakeApp(), { withConfig: false });
    expect(await h.list()).toBe(2);
    expect(h.err.text()).toContain('No honoe.config.ts found at /app/honoe.config.ts');
    expect(h.err.text()).toContain('honoe new');
  });

  it('exits 1 when the application fails to load', async () => {
    const h = harness(createFakeApp(), { loadFails: 'syntax error' });
    expect(await h.list()).toBe(1);
    expect(h.err.text()).toContain('syntax error');
  });

  it('exits 1 when the application fails to start', async () => {
    const h = harness(createFakeApp([], { failStart: 'no runtime capability' }));
    expect(await h.list()).toBe(1);
    expect(h.err.text()).toContain('no runtime capability');
  });
});

describe('the no-socket boot', () => {
  it('starts the application with NO port, so discovery binds nothing', async () => {
    const h = harness(createFakeApp([{ name: 'db:migrate', handler: noop }]));
    await h.list();
    expect(h.app.startCalls).toEqual([undefined]);
  });

  it('tears the application down after a successful listing', async () => {
    const h = harness(createFakeApp([{ name: 'db:migrate', handler: noop }]));
    await h.list();
    expect(h.app.stopCount()).toBe(1);
    expect(h.app.isStarted()).toBe(false);
  });

  it('tears down after a successful dispatch', async () => {
    const h = harness(createFakeApp([{ name: 'db:migrate', handler: noop }]));
    await h.dispatch('db:migrate');
    expect(h.app.stopCount()).toBe(1);
  });

  it('tears down when the handler throws', async () => {
    const h = harness(createFakeApp([
      {
        name: 'db:migrate',
        handler: () => {
          throw new Error('migration failed');
        },
      },
    ]));
    expect(await h.dispatch('db:migrate')).toBe(1);
    expect(h.app.stopCount()).toBe(1);
  });

  it('tears down when the command is not found', async () => {
    const h = harness(createFakeApp([{ name: 'db:migrate', handler: noop }]));
    await h.dispatch('nope');
    expect(h.app.stopCount()).toBe(1);
  });

  it('does not leave a half-started application after a failed start', async () => {
    const h = harness(createFakeApp([], { failStart: 'boom' }));
    await h.list();
    // stop() is still called; the kernel makes it a no-op when start() threw.
    expect(h.app.isStarted()).toBe(false);
    expect(h.app.stopCount()).toBe(0);
  });
});

describe('dispatchPluginCommand', () => {
  it('runs the matching handler and exits 0', async () => {
    let ran = false;
    const h = harness(createFakeApp([
      {
        name: 'db:migrate',
        handler: () => {
          ran = true;
        },
      },
    ]));
    expect(await h.dispatch('db:migrate')).toBe(0);
    expect(ran).toBe(true);
  });

  it('passes the trailing positionals to the handler', async () => {
    let seen: readonly string[] | undefined;
    const h = harness(createFakeApp([
      {
        name: 'db:migrate',
        handler: (args) => {
          seen = args;
        },
      },
    ]));
    await h.dispatch('db:migrate', ['--dir', '/app', 'up', '3']);
    expect(seen).toEqual(['up', '3']);
  });

  it('awaits an async handler', async () => {
    let done = false;
    const h = harness(createFakeApp([
      {
        name: 'db:migrate',
        handler: async () => {
          await Promise.resolve();
          done = true;
        },
      },
    ]));
    expect(await h.dispatch('db:migrate')).toBe(0);
    expect(done).toBe(true);
  });

  it('exits 1 with the handler message when it throws', async () => {
    const h = harness(createFakeApp([
      {
        name: 'db:migrate',
        handler: () => {
          throw new Error('migration failed');
        },
      },
    ]));
    expect(await h.dispatch('db:migrate')).toBe(1);
    expect(h.err.text()).toContain('migration failed');
  });

  it('exits 2 listing what IS available when the command is unknown', async () => {
    const h = harness(createFakeApp([{ name: 'db:migrate', handler: noop }]));
    expect(await h.dispatch('db:rollback')).toBe(2);
    expect(h.err.text()).toContain('Unknown command: db:rollback');
    expect(h.err.text()).toContain('db:migrate');
  });

  it('says so when the app registers no commands at all', async () => {
    const h = harness(createFakeApp([]));
    expect(await h.dispatch('db:migrate')).toBe(2);
    expect(h.err.text()).toContain('registers no plugin commands');
  });

  it('exits 2 naming honoe.config.ts when the project has none', async () => {
    const h = harness(createFakeApp(), { withConfig: false });
    expect(await h.dispatch('db:migrate')).toBe(2);
    expect(h.err.text()).toContain('Unknown command: db:migrate');
    expect(h.err.text()).toContain('No honoe.config.ts found');
  });

  it('never boots when the project has no config module', async () => {
    const h = harness(createFakeApp(), { withConfig: false });
    await h.dispatch('db:migrate');
    expect(h.app.startCalls).toEqual([]);
  });
});

describe('duplicate registrations', () => {
  const duplicated = () =>
    createFakeApp([
      { name: 'db:migrate', handler: noop },
      { name: 'db:migrate', handler: noop },
      { name: 'cache:clear', handler: noop },
    ]);

  it('refuses to dispatch, exiting 1', async () => {
    const h = harness(duplicated());
    expect(await h.dispatch('db:migrate')).toBe(1);
  });

  it('runs NEITHER handler', async () => {
    let runs = 0;
    const count = () => {
      runs++;
    };
    const h = harness(createFakeApp([
      { name: 'db:migrate', handler: count },
      { name: 'db:migrate', handler: count },
    ]));
    await h.dispatch('db:migrate');
    expect(runs).toBe(0);
  });

  it('names the command and how many plugins registered it', async () => {
    const h = harness(duplicated());
    await h.dispatch('db:migrate');
    expect(h.err.text()).toContain('"db:migrate" is registered 2 times');
    expect(h.err.text()).toContain('plugin load order');
  });

  it('refuses the listing too, rather than showing an ambiguous table', async () => {
    const h = harness(duplicated());
    expect(await h.list()).toBe(1);
    expect(h.err.text()).toContain('registered 2 times');
  });

  it('still refuses when the duplicate is not the command being run', async () => {
    const h = harness(duplicated());
    expect(await h.dispatch('cache:clear')).toBe(1);
  });
});

describe('--config and --dir', () => {
  it('loads from the --config override', async () => {
    const fs = createFakeFs({ '/app/wiring.ts': 'x' });
    const err = createRecorder();
    let seen: string | undefined;
    const code = await runCommandsListing(parseArgs(['--config', 'wiring.ts']), {
      fs,
      cwd: '/app',
      log: () => {},
      error: err.sink,
      loadApp: (url) => {
        seen = url;
        return Promise.resolve({ createApp: () => createFakeApp([]) });
      },
    });
    expect(code).toBe(0);
    expect(seen).toBe('file:///app/wiring.ts');
  });

  it('anchors a relative --dir to the working directory', async () => {
    const fs = createFakeFs({ '/work/proj/honoe.config.ts': 'x' });
    let seen: string | undefined;
    const code = await runCommandsListing(parseArgs(['--dir', 'proj']), {
      fs,
      cwd: '/work',
      log: () => {},
      error: () => {},
      loadApp: (url) => {
        seen = url;
        return Promise.resolve({ createApp: () => createFakeApp([]) });
      },
    });
    expect(code).toBe(0);
    expect(seen).toBe('file:///work/proj/honoe.config.ts');
  });
});

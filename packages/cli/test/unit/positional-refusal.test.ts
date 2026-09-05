import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs, type Recorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';

/**
 * The positional contracts of the built-in commands, refused at the dispatcher
 * beside the unknown-option refusal. `new` read one name and `generate` read
 * at most a schematic and a name, silently dropping the rest — `setu new app
 * extra junk` scaffolded `app` and reported success with exit 0 — and the
 * zero-positional commands (`adopt`, `workspace ports`, `commands`, `help`)
 * dropped everything they were handed. Each refusal below was observed to
 * pass (exit 0 or a different exit) with the round-2 `src/` change reverted.
 *
 * @module
 */

interface Harness {
  readonly fs: FakeFs;
  readonly out: Recorder;
  readonly err: Recorder;
  run(argv: readonly string[]): Promise<number>;
}

interface HarnessOptions {
  readonly seed?: Readonly<Record<string, string>>;
  readonly load?: () => Promise<{ schematic: () => readonly { path: string; contents: string }[] }>;
  readonly loadApp?: (url: string) => Promise<Record<string, unknown>>;
  readonly portAvailable?: (port: number) => Promise<boolean>;
}

function harness(options: HarnessOptions = {}): Harness {
  const fs = createFakeFs(options.seed ?? {});
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runCli(argv, {
        fs,
        cwd: '/work',
        now: () => Date.UTC(2026, 8, 5),
        log: out.sink,
        error: err.sink,
        ...(options.load === undefined ? {} : { load: options.load }),
        ...(options.loadApp === undefined ? {} : { loadApp: options.loadApp }),
        ...(options.portAvailable === undefined ? {} : { portAvailable: options.portAvailable }),
      }),
  };
}

const WORKSPACE_SEED = {
  '/work/setu.workspace.json': JSON.stringify({
    version: 1,
    runtime: 'deno',
    basePort: 3000,
    transport: 'http',
    members: [{ name: 'orders', port: 3000 }],
  }),
  '/work/deno.json': '{"workspace": ["./apps/*"]}',
};

describe('extra-positional refusal', () => {
  it('refuses `new app extra junk` with exit 2, writing nothing', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['new', 'app', 'extra', 'junk'])).toBe(2);
    expect(h.err.text()).toContain('setu new takes one project name; got 3.');
    expect(h.out.text()).not.toContain('would create');
    expect(h.out.text()).not.toContain('created');
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.mkdirs).toEqual([]);
  });

  it('refuses the n alias the same way', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['n', 'app', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu new takes one project name; got 2.');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses an extra name on a bare generate schematic', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['generate', 'service', 'billing', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu generate takes one name; got 2.');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses an extra name on generate custom', async () => {
    const h = harness({
      seed: WORKSPACE_SEED,
      load: () => Promise.resolve({ schematic: () => [{ path: 'out.txt', contents: 'hi' }] }),
    });
    expect(await h.run(['generate', 'custom', 'my-gen', 'thing', 'extra'])).toBe(2);
    expect(h.err.text()).toContain(
      'setu generate custom takes two names: the custom schematic and the artifact name; got 3.',
    );
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses an extra name on generate app', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['generate', 'app', 'billing', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu generate app takes one member name; got 2.');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses an extra name on generate library', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['generate', 'library', 'shared', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu generate library takes one library name; got 2.');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses any positional on adopt, which takes none', async () => {
    const h = harness({
      seed: {
        '/work/setu.config.ts': 'export function createApp() {}',
        '/work/main.ts': 'await app.start({ port: 3000 });',
      },
      portAvailable: () => Promise.resolve(true),
    });
    expect(await h.run(['adopt', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu adopt takes no arguments; got 1.');
    expect(h.fs.has('/work/setu.workspace.json')).toBe(false);
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a positional on workspace ports', async () => {
    const h = harness({
      seed: WORKSPACE_SEED,
      portAvailable: () => Promise.resolve(true),
    });
    expect(await h.run(['workspace', 'ports', 'extra', '--reallocate'])).toBe(2);
    expect(h.err.text()).toContain('setu workspace ports takes no arguments beyond ports; got 1.');
    expect(h.out.text()).not.toContain('Reallocated');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a positional on commands, which takes none', async () => {
    const h = harness({
      seed: { '/work/setu.config.ts': 'export function createApp() {}' },
      loadApp: (_url: string) =>
        Promise.resolve({
          createApp: () => ({
            services: { getAll: () => [{ name: 'db:migrate', handler: () => {} }] },
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
          }),
        }),
    });
    expect(await h.run(['commands', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu commands takes no arguments; got 1.');
    expect(h.out.text()).not.toContain('Commands provided');
  });

  it('refuses a positional on help and prints no usage', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['help', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('setu help takes no arguments; got 1.');
    expect(h.out.text()).not.toContain('Usage:');
  });

  it('the refusal fires under --dry-run, which cannot mask it', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['new', 'app', 'extra', 'junk', '--dry-run'])).toBe(2);
    expect(h.err.text()).toContain('setu new takes one project name; got 3.');
    expect(h.out.text()).not.toContain('would create');
    expect(h.fs.writes).toEqual([]);
  });

  it('tokens hidden behind the -- terminator are positionals and refuse too', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['new', 'app', '--dry-run', '--', 'extra', 'junk'])).toBe(2);
    expect(h.err.text()).toContain('setu new takes one project name; got 3.');
    expect(h.err.text()).not.toContain('Unknown option');
    expect(h.fs.writes).toEqual([]);
  });
});

describe('unchanged neighbors of the refusal', () => {
  it('add keeps its own X18-1 wording — the dispatcher does not preempt it', async () => {
    const h = harness({ seed: { '/work/deno.json': '{}' } });
    expect(await h.run(['add', 'auth', 'extra', 'junk'])).toBe(2);
    expect(h.err.text()).toContain('setu add takes one package; got 3.');
    expect(h.err.text()).toContain('Run it once per package.');
    expect(h.fs.writes).toEqual([]);
  });

  it('a missing generate name still usage-errors in the command body', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['generate', 'service'])).toBe(2);
    expect(h.err.text()).toContain('Usage: setu generate service <name>');
  });

  it('the non-ports workspace arm still refuses in the command body', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['workspace', 'bogus'])).toBe(2);
    expect(h.err.text()).toContain('Usage: setu workspace ports --reallocate');
  });

  it('an unknown command still reaches the plugin arm, positionals and all', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['frobnicate', 'extra'])).toBe(2);
    expect(h.err.text()).toContain('Unknown command: frobnicate');
  });
});

describe('the bare generate listing', () => {
  it('is informational — the schematic list on the log sink, exit 0', async () => {
    // Changed from exit 2 by decision: the listing bare `generate` prints IS
    // the help text (`--help` returns the identical output with exit 0), so
    // the error exit contradicted the output it carried. The refusals beside
    // it — a missing name, an unknown schematic, over-arity — are unchanged.
    const h = harness({ seed: WORKSPACE_SEED });
    expect(await h.run(['generate']), h.err.text()).toBe(0);
    expect(h.out.text()).toContain('Usage: setu generate <schematic> <name>');
    expect(h.out.text()).toContain('Schematics:');
    expect(h.err.text()).toBe('');
  });
});

describe('valid arities still succeed', () => {
  it('new takes its one name', async () => {
    const h = harness();
    expect(await h.run(['new', 'app']), h.err.text()).toBe(0);
    expect(h.fs.has('/work/app/deno.json')).toBe(true);
  });

  it('generate takes the schematic word and one name', async () => {
    const h = harness();
    expect(await h.run(['generate', 'service', 'billing']), h.err.text()).toBe(0);
    expect(h.fs.has('/work/src/services/billing.service.ts')).toBe(true);
  });

  it('generate custom takes the custom schematic and one name', async () => {
    const h = harness({
      load: () => Promise.resolve({ schematic: () => [{ path: 'out.txt', contents: 'hi' }] }),
    });
    expect(await h.run(['generate', 'custom', 'my-gen', 'thing']), h.err.text()).toBe(0);
    expect(h.fs.read('/work/out.txt')).toBe('hi');
  });

  it('generate app takes the verb and one member name', async () => {
    const h = harness({
      seed: WORKSPACE_SEED,
      portAvailable: () => Promise.resolve(true),
    });
    expect(await h.run(['generate', 'app', 'billing']), h.err.text()).toBe(0);
    expect(h.err.text()).not.toContain('takes');
  });

  it('generate library takes the verb and one name', async () => {
    const h = harness({ seed: WORKSPACE_SEED });
    expect(
      await h.run(['generate', 'library', 'shared', '--dry-run']),
      h.err.text(),
    ).toBe(0);
    expect(h.err.text()).not.toContain('takes');
  });

  it('adopt takes no positionals and still adopts', async () => {
    const h = harness({
      seed: {
        '/work/setu.config.ts': 'export function createApp() {}',
        '/work/main.ts': 'await app.start({ port: 3000 });',
      },
      portAvailable: () => Promise.resolve(true),
    });
    expect(await h.run(['adopt']), h.err.text()).toBe(0);
    expect(h.fs.has('/work/setu.workspace.json')).toBe(true);
  });

  it('workspace ports takes no positionals and still reallocates', async () => {
    const h = harness({
      seed: WORKSPACE_SEED,
      portAvailable: () => Promise.resolve(true),
    });
    expect(await h.run(['workspace', 'ports', '--reallocate']), h.err.text()).toBe(0);
    expect(h.out.text()).toContain('Reallocated workspace ports');
  });

  it('commands takes no positionals and still lists', async () => {
    const h = harness({
      seed: { '/work/setu.config.ts': 'export function createApp() {}' },
      loadApp: (_url: string) =>
        Promise.resolve({
          createApp: () => ({
            services: { getAll: () => [{ name: 'db:migrate', handler: () => {} }] },
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
          }),
        }),
    });
    expect(await h.run(['commands']), h.err.text()).toBe(0);
    expect(h.out.text()).toContain('db:migrate');
  });

  it('help takes no positionals and still prints usage', async () => {
    const h = harness();
    expect(await h.run(['help'])).toBe(0);
    expect(h.out.text()).toContain('Usage:');
  });

  it('a plugin command still receives every positional verbatim', async () => {
    let received: readonly string[] = [];
    const h = harness({
      seed: { '/work/setu.config.ts': 'export function createApp() {}' },
      loadApp: (_url: string) =>
        Promise.resolve({
          createApp: () => ({
            services: {
              getAll: () => [
                {
                  name: 'db:migrate',
                  handler: (args: readonly string[]) => {
                    received = args;
                  },
                },
              ],
            },
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
          }),
        }),
    });
    expect(await h.run(['db:migrate', 'prod', 'extra']), h.err.text()).toBe(0);
    expect(received).toEqual(['prod', 'extra']);
  });
});

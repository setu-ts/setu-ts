import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import type { FakeFs, Recorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { commandFlagsFor, DOCUMENTED_FLAGS, suggestFlag } from '../../src/flags.ts';

/**
 * The flags `--help` presents, parsed from the RENDERED text — the inventory
 * gate reads what a user reads, not the source literals.
 *
 * Long flags (`--dir`) and short aliases in `--yes, -y` position are captured;
 * the global help flags are dropped by the caller, since the per-command help
 * texts do not present them (the top-level help does).
 */
function parseHelpFlags(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/--([a-z][a-z0-9-]*)/g)) names.add(match[1]);
  for (const match of text.matchAll(/(?:^|[\s,])-([a-z])\b/g)) names.add(match[1]);
  return names;
}

interface IHarness {
  readonly fs: FakeFs;
  readonly out: Recorder;
  readonly err: Recorder;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}): IHarness {
  const fs = createFakeFs(seed);
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
  // The workspace root manifest `generate library` may edit; an unparseable or
  // absent one is refused before any plan is printed.
  '/work/deno.json': '{"workspace": ["./apps/*"]}',
};

/**
 * A harness whose project has a config module, booted through an injected
 * loader. `wasBooted()` reports whether the loader ran — the seam a plugin
 * command's refusal must not reach.
 */
function withApp(commands: readonly { name: string; handler: () => void }[]): {
  readonly fs: FakeFs;
  readonly err: Recorder;
  wasBooted(): boolean;
  run(argv: readonly string[]): Promise<number>;
} {
  const fs = createFakeFs({ '/work/setu.config.ts': 'export function createApp() {}' });
  const err = createRecorder();
  let booted = false;
  const appModule = () => {
    booted = true;
    return Promise.resolve({
      createApp: () => ({
        services: { getAll: () => commands },
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
    });
  };
  return {
    fs,
    err,
    wasBooted: () => booted,
    run: (argv) =>
      runCli(argv, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: err.sink,
        loadApp: appModule,
      }),
  };
}

describe('unknown-option refusal', () => {
  it('refuses --templat rest on new even under --dry-run, with a suggestion, writing nothing', async () => {
    const h = harness();
    expect(await h.run(['new', 'app', '--dry-run', '--templat', 'rest'])).toBe(2);
    expect(h.err.text()).toContain(
      'Unknown option `--templat` for `setu new`. Did you mean `--template`?',
    );
    expect(h.out.text()).not.toContain('would create');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a bare unknown flag without manufacturing a suggestion', async () => {
    const h = harness();
    expect(await h.run(['new', 'app', '--totally-bogus-flag'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--totally-bogus-flag` for `setu new`.');
    expect(h.err.text()).not.toContain('Did you mean');
    expect(h.fs.writes).toEqual([]);
  });

  for (const flag of ['--__proto__', '--__proto__=value']) {
    it(`refuses ${flag} before new can write files`, async () => {
      const h = harness();
      expect(await h.run(['new', 'app', flag])).toBe(2);
      expect(h.err.text()).toContain('Unknown option `--__proto__` for `setu new`.');
      expect(h.fs.writes).toEqual([]);
    });
  }

  it('suggests --port for --base-port on new', async () => {
    const h = harness();
    expect(await h.run(['new', 'acme', '--workspace', '--base-port', '9999'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--base-port` for `setu new`.');
    expect(h.err.text()).toContain('Did you mean `--port`?');
  });

  it('names each command and its alias in the refusal, subcommand-aware', async () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['new', 'app', '--templat'], 'setu new'],
      [['n', 'app', '--templat'], 'setu new'],
      [['generate', 'service', 'x', '--runtim', 'bun'], 'setu generate'],
      [['generate', 'app', 'x', '--dryrun'], 'setu generate app'],
      [['generate', 'library', 'x', '--scop', 'acme'], 'setu generate library'],
      [['add', 'auth', '--dryrun'], 'setu add'],
      [['adopt', '--dryrun'], 'setu adopt'],
      [['workspace', 'ports', '--reallocat'], 'setu workspace ports'],
      [['workspace', '--reallocat'], 'setu workspace'],
      [['workspace', 'bogus-sub', '--bogus'], 'setu workspace'],
      [['commands', '--bogus'], 'setu commands'],
      [['help', '--bogus'], 'setu help'],
    ];
    for (const [argv, label] of cases) {
      const h = harness(WORKSPACE_SEED);
      expect(await h.run(argv), `${argv.join(' ')}`).toBe(2);
      expect(h.err.lines[0], argv.join(' ')).toContain(`Unknown option `);
      expect(h.err.lines[0], argv.join(' ')).toContain(`for \`${label}\`.`);
      expect(h.fs.writes, argv.join(' ')).toEqual([]);
    }
  });

  it('never reports `--` terminator tokens or -k=value keys as unknown flags', async () => {
    // Round 2: everything after `--` is a POSITIONAL ([`parseArgs`]), so this
    // invocation now carries three names where `new` takes one — refused as
    // the positional twin of this module's flag check, never misreported as
    // an unknown option.
    const terminated = harness();
    expect(await terminated.run(['new', 'app', '--dry-run', '--', '--templat', 'rest'])).toBe(2);
    expect(terminated.err.text()).toContain('setu new takes one project name; got 3.');
    expect(terminated.err.text()).not.toContain('Unknown option');
    expect(terminated.out.text()).not.toContain('would create');
    expect(terminated.fs.writes).toEqual([]);

    const shortValue = harness();
    expect(await shortValue.run(['g', 'service', 'billing', '--dir=/other', '--dry-run'])).toBe(0);
    expect(shortValue.err.text()).not.toContain('Unknown option');
    expect(shortValue.out.text()).toContain('would create /other/src/services/billing.service.ts');
  });

  it('does not disturb the paths without a flag problem', async () => {
    const unknownCommand = harness();
    expect(await unknownCommand.run(['frobnicate', '--bogus'])).toBe(2);
    expect(unknownCommand.err.text()).toContain('Unknown command: frobnicate');

    const bare = harness();
    expect(await bare.run([])).toBe(2);
    expect(bare.out.text()).toContain('Usage:');
  });
});

describe('every documented flag is accepted', () => {
  const standalone: readonly (readonly [string, readonly string[]])[] = [
    ['template', ['--template', 'rest']],
    ['runtime', ['--runtime', 'bun']],
    ['env-file', ['--template', 'rest', '--env-file', 'config/.env.local']],
    ['broker', ['--template', 'microservice', '--broker', 'memory']],
    ['queue', ['--template', 'microservice', '--queue', 'memory']],
    ['yes', ['--yes']],
    ['y', ['-y']],
    ['dir', ['--dir', '/elsewhere']],
    ['dry-run', ['--dry-run']],
  ];

  for (const [name, flags] of standalone) {
    it(`accepts new --${name}`, async () => {
      const h = harness();
      expect(await h.run(['new', `probe-${name}`, ...flags]), h.err.text()).toBe(0);
      expect(h.err.text()).not.toContain('Unknown option');
    });
  }

  it('accepts the workspace-only new flags together', async () => {
    const h = harness();
    expect(
      await h.run([
        'new',
        'acme',
        '--workspace',
        '--port',
        '4100',
        '--transport',
        'redis',
        '--transport-url',
        'redis://localhost:6379',
      ]),
      h.err.text(),
    ).toBe(0);
  });

  it('accepts the generate flags', async () => {
    const h = harness();
    expect(
      await h.run(['g', 'service', 'billing', '--runtime', 'bun', '--dir', '/other', '--dry-run']),
      h.err.text(),
    ).toBe(0);
  });

  it('accepts every generate app flag', async () => {
    const h = harness(WORKSPACE_SEED);
    expect(
      await h.run([
        'generate',
        'app',
        'billing',
        '--template',
        'rest',
        '--port',
        '3100',
        '--env-file',
        'config/.env',
        '--depends-on',
        'orders',
        '--dir',
        '/work',
        '--dry-run',
      ]),
      h.err.text(),
    ).toBe(0);
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('accepts every generate library flag', async () => {
    const h = harness(WORKSPACE_SEED);
    expect(
      await h.run([
        'generate',
        'library',
        'shared',
        '--scope',
        'acme',
        '--dir',
        '/work',
        '--dry-run',
      ]),
      h.err.text(),
    ).toBe(0);
  });

  it('accepts every add flag', async () => {
    const h = harness({ '/work/deno.json': '{}' });
    expect(await h.run(['add', 'auth', '--dir', '/work', '--dry-run']), h.err.text()).toBe(0);
  });

  it('accepts every adopt flag', async () => {
    const h = harness({
      '/work/setu.config.ts': 'export function createApp() {}',
      '/work/main.ts': 'await app.start({ port: 3000 });',
    });
    expect(
      await h.run(['adopt', '--name', 'acme', '--port', '3100', '--dir', '/work', '--dry-run']),
      h.err.text(),
    ).toBe(0);
  });

  it('accepts every workspace ports flag', async () => {
    const fs = createFakeFs(WORKSPACE_SEED);
    const out = createRecorder();
    expect(
      await runCli(['workspace', 'ports', '--reallocate', '--dir', '/work', '--dry-run'], {
        fs,
        cwd: '/work',
        now: () => 0,
        log: out.sink,
        error: createRecorder().sink,
        portAvailable: () => Promise.resolve(true),
      }),
    ).toBe(0);
    expect(out.text()).toContain('would update');
  });

  it('accepts the global flags, bare and with a command', async () => {
    for (
      const argv of [
        ['--version'],
        ['-v'],
        ['--help'],
        ['-h'],
        ['help'],
        ['new', 'app', '--version'],
        ['new', '--help'],
        ['g', 'service', 'x', '-h'],
        ['workspace', '--help'],
      ]
    ) {
      const h = harness();
      expect(await h.run(argv), argv.join(' ')).toBe(0);
    }
  });

  it('accepts dir and config on the commands verb', async () => {
    const h = harness();
    expect(await h.run(['commands', '--dir', '/work', '--config', 'other.ts'])).toBe(2);
    expect(h.err.text()).toContain('No setu.config.ts');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  for (const flag of ['--help', '-h']) {
    it(`prints top-level help for commands ${flag} without loading a project`, async () => {
      const h = harness();
      expect(await h.run(['commands', flag])).toBe(0);
      expect(h.out.text()).toContain('Usage:');
      expect(h.err.text()).toBe('');
    });
  }

  it('refuses an unsupported flag alongside commands help before printing it', async () => {
    const h = harness();
    expect(await h.run(['commands', '--help', '--templat'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--templat` for `setu commands`.');
    expect(h.out.text()).toBe('');
  });
});

describe('help text agrees with the inventory', () => {
  const gateCases: readonly (readonly [string, readonly string[]])[] = [
    ['new', ['new', '--help']],
    ['generate', ['generate', '--help']],
    ['generate app', ['generate', 'app', '--help']],
    ['generate library', ['generate', 'library', '--help']],
    ['add', ['add', '--help']],
    ['adopt', ['adopt', '--help']],
    ['workspace ports', ['workspace', 'ports', '--help']],
  ];

  for (const [label, argv] of gateCases) {
    it(`${label}: the rendered --help and the allowlist agree in both directions`, async () => {
      const h = harness();
      expect(await h.run(argv), h.err.text()).toBe(0);
      const parsed = parseHelpFlags(h.out.text());
      // The global help flags live in the top-level help, not the per-command
      // one, so they are exempt from this comparison in both directions.
      parsed.delete('help');
      parsed.delete('h');
      const documented = DOCUMENTED_FLAGS.get(label);
      if (documented === undefined) throw new Error(`no inventory entry for ${label}`);
      // Direction 1: every flag the help text presents is in the allowlist.
      expect([...parsed].sort(), `${label}: help text flags`).toEqual([...documented].sort());
      // Direction 2: every documented allowlist flag appears in the help text.
      expect([...documented].sort(), `${label}: inventory flags`).toEqual([...parsed].sort());
    });
  }

  it('keeps the named-refusal flags recognized even though no help text presents them', () => {
    const newFlags = commandFlagsFor('new', undefined);
    expect(newFlags?.allowed).toContain('di');
    expect(newFlags?.allowed).toContain('depends-on');
    const appFlags = commandFlagsFor('generate', 'app');
    expect(appFlags?.allowed).toContain('transport');
    expect(appFlags?.allowed).toContain('runtime');
    expect(appFlags?.allowed).toContain('di');
  });
});

describe('named refusals keep precedence over the generic check', () => {
  it('workspace --reallocate with ports omitted reaches the body teaching usage, not the generic refusal', async () => {
    // The subcommand omission is what the usage line teaches: the body's own
    // message names `workspace ports --reallocate`, so it — not "Unknown
    // option" — is the answer to the invocation.
    const h = harness();
    expect(await h.run(['workspace', '--reallocate'])).toBe(2);
    expect(h.err.text()).toContain('Usage: setu workspace ports --reallocate');
    expect(h.err.text()).not.toContain('Unknown option');
    expect(h.fs.writes).toEqual([]);
  });

  it('a genuinely foreign flag on bare workspace stays strictly refused', async () => {
    const h = harness();
    expect(await h.run(['workspace', '--totally-bogus'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--totally-bogus` for `setu workspace`.');
    expect(h.err.text()).not.toContain('Did you mean');
    expect(h.fs.writes).toEqual([]);
  });

  it('setu new --di keeps its specific M65 guidance', async () => {
    const h = harness();
    expect(await h.run(['new', 'app', '--di'])).toBe(2);
    expect(h.err.text()).toContain('no longer supported. Use `--template class-based`');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('setu new --workspace --di keeps it on the workspace path too', async () => {
    const h = harness();
    expect(await h.run(['new', 'acme', '--workspace', '--di'])).toBe(2);
    expect(h.err.text()).toContain('no longer supported. Use `--template class-based`');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('setu new --depends-on keeps its specific guidance', async () => {
    const h = harness();
    expect(await h.run(['new', 'app', '--depends-on', 'orders'])).toBe(2);
    expect(h.err.text()).toContain('--depends-on applies to');
    expect(h.err.text()).toContain('generate app');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('generate app --transport keeps its workspace-wide guidance', async () => {
    const h = harness(WORKSPACE_SEED);
    expect(await h.run(['generate', 'app', 'billing', '--transport', 'http'])).toBe(2);
    expect(h.err.text()).toContain('workspace-wide choice');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('generate app --runtime keeps its workspace-toolchain guidance', async () => {
    const h = harness(WORKSPACE_SEED);
    expect(await h.run(['generate', 'app', 'billing', '--runtime', 'node'])).toBe(2);
    expect(h.err.text()).toContain('deno workspace');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('generate app --di keeps its specific M65 guidance', async () => {
    const h = harness(WORKSPACE_SEED);
    expect(await h.run(['generate', 'app', 'billing', '--di'])).toBe(2);
    expect(h.err.text()).toContain('no longer supported. Use `--template class-based`');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('the renamed-template refusal survives (a template VALUE, not a flag)', async () => {
    const h = harness();
    expect(await h.run(['new', 'app', '--template', 'nest'])).toBe(2);
    expect(h.err.text()).toContain('renamed to "class-based"');
    expect(h.err.text()).not.toContain('Unknown option');
  });
});

describe('suggestion mechanics', () => {
  it('suggests the nearest long name within the documented threshold', () => {
    const candidates = ['template', 'runtime', 'dir', 'dry-run', 'port', 'queue'];
    expect(suggestFlag('templat', candidates)).toBe('template');
    expect(suggestFlag('dryrun', candidates)).toBe('dry-run');
    expect(suggestFlag('base-port', candidates)).toBe('port');
  });

  it('suggests nothing for junk far from every candidate', () => {
    const candidates = ['template', 'runtime', 'dir', 'dry-run', 'port', 'queue', 'yes', 'y'];
    expect(suggestFlag('totally-bogus-flag', candidates)).toBeUndefined();
    expect(suggestFlag('xyz', candidates)).toBeUndefined();
  });

  it('never suggests a single-letter alias, however close', () => {
    expect(suggestFlag('z', ['y', 'h', 'dir'])).toBeUndefined();
  });
});

describe('plugin commands', () => {
  for (const flag of ['--__proto__', '--__proto__=value']) {
    it(`refuses ${flag} before the plugin command boots`, async () => {
      const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
      expect(await h.run(['db:migrate', flag])).toBe(2);
      expect(h.err.text()).toContain('Unknown option `--__proto__` for `setu db:migrate`.');
      expect(h.wasBooted()).toBe(false);
    });
  }

  it('refuses a flag the dispatcher does not consume, before the app boots and the handler runs', async () => {
    let ran = false;
    const h = withApp([{
      name: 'db:migrate',
      handler: () => {
        ran = true;
      },
    }]);
    expect(await h.run(['db:migrate', '--verbose'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--verbose` for `setu db:migrate`.');
    // The refusal sits ABOVE the boot in `dispatchPluginCommand`: the loader is
    // never invoked, so no plugin init/bootstrap hook runs for a typo'd flag.
    expect(h.wasBooted()).toBe(false);
    expect(ran).toBe(false);
  });

  it('accepts dir and config, the flags its dispatcher consumes', async () => {
    let ran = false;
    const h = withApp([{
      name: 'db:migrate',
      handler: () => {
        ran = true;
      },
    }]);
    expect(await h.run(['db:migrate', '--dir', '/work', '--config', 'setu.config.ts'])).toBe(0);
    // A valid plugin command still boots and dispatches.
    expect(h.wasBooted()).toBe(true);
    expect(ran).toBe(true);
  });

  it('refuses --help, which no plugin-command path handles', async () => {
    const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
    expect(await h.run(['db:migrate', '--help'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--help` for `setu db:migrate`.');
    expect(h.wasBooted()).toBe(false);
  });

  it('keeps the missing-config messages even when the flag is unknown too', async () => {
    // No config module and no loader injected: the missing-config refusal keeps
    // its precedence over the flag check, and nothing is ever loaded.
    const h = harness();
    expect(await h.run(['db:migrate', '--verbse'])).toBe(2);
    expect(h.err.lines[0]).toContain('Unknown command: db:migrate');
    expect(h.err.text()).toContain('No setu.config.ts found');
    expect(h.err.text()).not.toContain('Unknown option');
  });

  it('refuses a typo flag on a command the app does not register either — the flag wins', async () => {
    // The one message this round moves: with the config module present, a
    // typo'd flag refuses before the boot that would have discovered the
    // command was absent.
    const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
    expect(await h.run(['db:nope', '--verbse'])).toBe(2);
    expect(h.err.text()).toContain('Unknown option `--verbse` for `setu db:nope`.');
    expect(h.wasBooted()).toBe(false);
    expect(h.err.text()).not.toContain('Unknown command');
  });
});

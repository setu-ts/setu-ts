/**
 * Tests for `setu add <plugin>` (D3).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  addableNames,
  resolveAddablePackage,
  runAddCommand,
  withDependency,
  withIngressProviderWiring,
} from '../../../src/commands/add.ts';
import { VERSION } from '../../../src/constants.ts';
import { parseArgs } from '../../../src/args.ts';
import { listSchematics } from '../../../src/schematics/registry.ts';

/** Builds a command harness over a fake filesystem. */
function harness(files: Readonly<Record<string, string>> = {}) {
  const fs = createFakeFs(files);
  const out: string[] = [];
  const err: string[] = [];
  return {
    fs,
    out,
    err,
    read: (path: string) => fs.read(path),
    // Parsed by the REAL `parseArgs`, not by a local reimplementation. The
    // hand-rolled one turned every flag into boolean `true`, so `--dir <path>` —
    // which `VALUE_FLAGS` resolves to a STRING — was never exercised, and
    // reading the wrong flag name would have passed all twelve tests.
    run: (argv: readonly string[]) =>
      runAddCommand(
        parseArgs(argv),
        { fs, cwd: '/app', log: (m) => out.push(m), error: (m) => err.push(m) },
      ),
  };
}

const DENO_MANIFEST = JSON.stringify(
  {
    tasks: { start: 'deno run main.ts' },
    imports: { '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^1' },
  },
  null,
  2,
);

const CLASS_BASED_INGRESS_CONFIG = `import { createApplication } from '@setu-ts/kernel';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { INGRESS_HANDLERS } from './src/ingress/index.ts';

export function createApp() {
  return createApplication({
    plugins: [
      DecoratorPlugin({
        ingress: [...INGRESS_HANDLERS],
      }),
    ],
  });
}
`;

describe('resolveAddablePackage', () => {
  it('accepts a short name', () => {
    expect(resolveAddablePackage('auth')).toBe('auth-plugin');
  });

  it('accepts the full specifier, so both spellings are one command', () => {
    expect(resolveAddablePackage('@setu-ts/auth-plugin')).toBe('auth-plugin');
  });

  it('accepts the bare package name', () => {
    expect(resolveAddablePackage('auth-plugin')).toBe('auth-plugin');
  });

  it('refuses a name it does not know', () => {
    // The range this writes is the CLI's OWN version, which is only correct for
    // packages released as one version with it — so a typo has to be refused
    // rather than pinned to a version that does not exist.
    expect(resolveAddablePackage('authh')).toBeUndefined();
    expect(resolveAddablePackage('@setu-ts/express')).toBeUndefined();
  });

  it('covers every gate a schematic can declare', () => {
    // DERIVED from the registry, not a hand-written list. The list version had
    // already gone stale — it still named `decorator`, which stopped being a
    // gate on this branch — and it could not have noticed a NEWLY gated
    // schematic whose plugin is missing here, which is the failure it exists to
    // prevent: `setu generate` would name a command that then refuses.
    const gates = listSchematics()
      .map(({ requiresPlugin }) => requiresPlugin)
      .filter((plugin): plugin is string => plugin !== undefined);

    expect(gates.length, 'no gated schematics — this check would be vacuous')
      .toBeGreaterThan(0);
    for (const plugin of gates) {
      expect(resolveAddablePackage(plugin), plugin).toBe(plugin);
    }
  });
});

describe('withDependency', () => {
  it('adds the entry and keeps the rest of the manifest', () => {
    const updated = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    const parsed = JSON.parse(updated ?? '') as {
      tasks: Record<string, string>;
      imports: Record<string, string>;
    };

    expect(parsed.imports['@setu-ts/auth-plugin']).toBe('jsr:x@^1');
    expect(parsed.imports['@setu-ts/kernel']).toBe('jsr:@setu-ts/kernel@^1');
    expect(parsed.tasks['start']).toBe('deno run main.ts');
  });

  it('sorts the map, so a later regeneration does not reorder the file', () => {
    const updated = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/audit-plugin', 'jsr:x@^1');
    const keys = Object.keys(
      (JSON.parse(updated ?? '') as { imports: Record<string, string> }).imports,
    );
    expect(keys).toEqual([...keys].sort());
  });

  it('reports no change when the entry is already present with that value', () => {
    const once = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(withDependency(once ?? '', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1'))
      .toBeUndefined();
  });

  it('creates the section when the manifest has none', () => {
    const updated = withDependency('{}', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(JSON.parse(updated ?? '')).toEqual({ imports: { '@setu-ts/auth-plugin': 'jsr:x@^1' } });
  });
});

describe('withIngressProviderWiring', () => {
  for (
    const [bare, symbol] of [
      ['cqrs-plugin', 'CqrsPlugin'],
      ['events-plugin', 'EventsPlugin'],
      ['messaging-plugin', 'MessagingPlugin'],
      ['queue-plugin', 'QueuePlugin'],
      ['scheduler-plugin', 'SchedulerPlugin'],
      ['websocket-plugin', 'WebSocketPlugin'],
    ] as const
  ) {
    it(`activates ${bare} in the generated class-based ingress config`, () => {
      const updated = withIngressProviderWiring(CLASS_BASED_INGRESS_CONFIG, bare);

      expect(updated).toContain(`import { ${symbol} } from '@setu-ts/${bare}';`);
      expect(updated).toContain(`      ${symbol}(),`);
    });
  }

  it('does not rewrite a custom decorator config or a provider it already constructs', () => {
    const custom = CLASS_BASED_INGRESS_CONFIG.replace(
      'ingress: [...INGRESS_HANDLERS],',
      'controllers: [],',
    );
    expect(withIngressProviderWiring(custom, 'events-plugin')).toBeUndefined();

    const once = withIngressProviderWiring(CLASS_BASED_INGRESS_CONFIG, 'events-plugin') ?? '';
    expect(withIngressProviderWiring(once, 'events-plugin')).toBeUndefined();
    expect(withIngressProviderWiring(CLASS_BASED_INGRESS_CONFIG, 'auth-plugin')).toBeUndefined();
  });

  it('reuses a provider import that exists before its plugin construction is added', () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
      "import { EventsPlugin } from '@setu-ts/events-plugin';\n" +
        "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
    );
    const updated = withIngressProviderWiring(source, 'events-plugin') ?? '';

    expect(updated.match(/import \{ EventsPlugin \} from '@setu-ts\/events-plugin';/g))
      .toHaveLength(1);
    expect(updated).toContain('      EventsPlugin(),');
  });

  it('uses an aliased provider import for its generated construction', () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
      "import { EventsPlugin as AppEvents } from '@setu-ts/events-plugin';\n" +
        "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
    );
    const updated = withIngressProviderWiring(source, 'events-plugin') ?? '';

    expect(updated).toContain(
      "import { EventsPlugin as AppEvents } from '@setu-ts/events-plugin';",
    );
    expect(updated).not.toContain("import { EventsPlugin } from '@setu-ts/events-plugin';");
    expect(updated).toContain('      AppEvents(),');
  });
});

describe('runAddCommand', () => {
  it('refuses with exit 1 and writes nothing when a runtime marker is unreadable', async () => {
    const fs = createFakeFs({ '/app/deno.json': DENO_MANIFEST, '/app/wrangler.jsonc': '{}' });
    const err: string[] = [];
    const code = await runAddCommand(parseArgs(['cloudflare-plugin']), {
      fs: {
        ...fs,
        readFile: (path: string) =>
          path === '/app/wrangler.jsonc'
            ? Promise.reject(new Error('EACCES: permission denied'))
            : fs.readFile(path),
      },
      cwd: '/app',
      log: () => {},
      error: (m) => err.push(m),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Cannot read /app/wrangler.jsonc: EACCES');
    expect(fs.writes).toEqual([]);
  });

  it('refuses plugins that cannot register on the detected runtime', async () => {
    const node = harness({
      '/app/package.json': JSON.stringify({ scripts: { start: 'node main.ts' } }),
    });
    expect(await node.run(['cloudflare'])).toBe(2);
    expect(node.err.join('\n')).toContain('Cloudflare Workers');
    expect(node.fs.writes).toEqual([]);

    const workers = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': '{}',
      '/app/wrangler.toml': 'name = "app"',
    });
    expect(await workers.run(['scheduler'])).toBe(2);
    expect(workers.err.join('\n')).toContain('unavailable on Cloudflare Workers');
    expect(workers.fs.writes).toEqual([]);
  });

  it('refuses to rewrite JSONC and prints the exact entry to add', async () => {
    const h = harness({ '/app/deno.jsonc': '{\n  // pins\n  "imports": {},\n}\n' });
    expect(await h.run(['auth'])).toBe(1);
    expect(h.err.join('\n')).toContain('rewriting it would discard');
    expect(h.err.join('\n')).toContain('"@setu-ts/auth-plugin"');
    expect(h.fs.writes).toEqual([]);
  });

  it('pins the package at the CLI own version', async () => {
    // The rule `setu new` already follows, so a project's framework packages
    // stay on one version rather than drifting per install.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['auth'])).toBe(0);

    const parsed = JSON.parse(h.read('/app/deno.json')) as { imports: Record<string, string> };
    expect(parsed.imports['@setu-ts/auth-plugin']).toBe(`jsr:@setu-ts/auth-plugin@^${VERSION}`);
  });

  it('reports the install command rather than running it', async () => {
    // On release day `deno install` hits the 24-hour minimum-dependency-age
    // policy, so the developer needs to SEE the flags rather than watch an
    // opaque subprocess fail (D1).
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['auth']);

    expect(h.out.join('\n')).toContain('deno install --min-dep-age 0');
  });

  it('updates BOTH manifests when a project carries both', async () => {
    // A Workers or Node project has a `package.json` for its toolchain AND a
    // `deno.json` that `setu generate` reads for gating — writing only one
    // would leave the gate and the build disagreeing.
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': JSON.stringify({ name: 'edge', dependencies: {} }, null, 2),
    });
    expect(await h.run(['auth'])).toBe(0);

    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/auth-plugin']).toBeDefined();
    expect(JSON.parse(h.read('/app/package.json')).dependencies['@setu-ts/auth-plugin'])
      .toBe(`npm:@jsr/setu-ts__auth-plugin@^${VERSION}`);
  });

  it('activates an ingress provider in the generated class-based config', async () => {
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': CLASS_BASED_INGRESS_CONFIG,
    });

    expect(await h.run(['events'])).toBe(0);

    const config = h.read('/app/setu.config.ts');
    expect(config).toContain(`import { EventsPlugin } from '@setu-ts/events-plugin';`);
    expect(config).toContain('      EventsPlugin(),');
    expect(h.out.join('\n')).toContain('updated /app/setu.config.ts');
  });

  it('keeps an ingress config untouched under --dry-run', async () => {
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': CLASS_BASED_INGRESS_CONFIG,
    });

    expect(await h.run(['events', '--dry-run'])).toBe(0);
    expect(h.read('/app/setu.config.ts')).toBe(CLASS_BASED_INGRESS_CONFIG);
    expect(h.out.join('\n')).toContain('would update /app/setu.config.ts');
  });

  it('is idempotent', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['auth']);
    const afterFirst = h.read('/app/deno.json');

    expect(await h.run(['auth'])).toBe(0);
    expect(h.read('/app/deno.json')).toBe(afterFirst);
    expect(h.out.join('\n')).toContain('already installed');
  });

  it('writes nothing under --dry-run', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['auth', '--dry-run'])).toBe(0);

    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
    expect(h.out.join('\n')).toContain('would update');
  });

  it('refuses an unknown name and lists what it accepts', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['authh'])).toBe(2);

    expect(h.err.join('\n')).toContain('not a Setu-TS package');
    // The listing, specifically. Asserting `'auth'` was vacuous: the refusal
    // echoes the rejected name, and `"authh"` contains it — so deleting the
    // Available line entirely left this test green.
    expect(h.err.join('\n')).toContain(`Available: ${addableNames().join(', ')}`);
    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
  });

  it('honours --dir, resolving a relative path against the working directory', async () => {
    // The harness used to reduce every flag to boolean `true`, so this path was
    // never taken and `stringFlag(args.flags, 'dir')` could have named any key
    // at all. Driven through the real parser, both spellings must work.
    const h = harness({ '/app/services/orders/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', '--dir', 'services/orders'])).toBe(0);
    expect(JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'])
      .toBeDefined();
  });

  it('accepts --dir=<path> as well as --dir <path>', async () => {
    const h = harness({ '/app/services/orders/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', '--dir=services/orders'])).toBe(0);
    expect(JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'])
      .toBeDefined();
  });

  it('refuses a directory that is not a project', async () => {
    const h = harness();
    expect(await h.run(['auth'])).toBe(1);
    expect(h.err.join('\n')).toContain('not a Setu-TS project');
  });

  it('refuses a manifest it cannot parse, naming the file', async () => {
    const h = harness({ '/app/deno.json': '{ not json' });
    expect(await h.run(['auth'])).toBe(1);
    expect(h.err.join('\n')).toContain('as JSON');
  });

  it('returns a usage error with no package named', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run([])).toBe(2);
  });

  it('refuses a second positional with exit 2, writing nothing (X18-1)', async () => {
    // X18-1: five requested packages used to report `updated deno.json` and
    // exit 0 with one added — the contract is singular and exceeding it is a
    // usage error, like every other misapplied input to this CLI.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', 'cache', 'logger'])).toBe(2);

    expect(h.err.join('\n')).toContain('takes one package; got 3');
    expect(h.err.join('\n')).toContain('Run it once per package');
    // The manifest is untouched: refused, not partially applied.
    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
  });

  it('keeps the one-positional form unchanged', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth'])).toBe(0);

    expect(h.out.join('\n')).toContain('updated /app/deno.json');
    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/auth-plugin']).toBeDefined();
  });

  it('lists every addable package under --help', async () => {
    const h = harness();
    expect(await h.run(['--help'])).toBe(0);
    for (const name of addableNames()) {
      expect(h.out.join('\n')).toContain(name);
    }
  });
});

describe('setu add — permission notes (X8-9)', () => {
  it('should tell a storage installer that the local provider needs --allow-write', async () => {
    // X8-9: with `STORAGE_PROVIDER=local`, an otherwise untouched scaffolded
    // project answered every upload with a parse failure while `/health` said
    // `up`, because the generated `start` task requests `--allow-read` and not
    // `--allow-write`. The provider now refuses to connect with the flag named;
    // this is the earlier of the two signals.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['storage'])).toBe(0);

    const output = h.out.join('\n');
    expect(output).toContain('--allow-write');
    expect(output).toContain("'local' provider");
  });

  it('should say nothing about permissions for a package that needs none', async () => {
    // The note must not become boilerplate printed after every add, or it stops
    // being read.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth'])).toBe(0);

    expect(h.out.join('\n')).not.toContain('--allow-write');
  });
});

describe('setu add — install command per runtime', () => {
  const pkg = (start: string) =>
    JSON.stringify({ name: 'svc', scripts: { start }, dependencies: {} }, null, 2);

  it('prints npm install for a Node project, never deno install', async () => {
    const h = harness({ '/app/package.json': pkg('tsx main.ts'), '/app/.npmrc': '' });
    expect(await h.run(['cache'])).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('  npm install');
    expect(out).not.toContain('deno install');
  });

  it('prints bun install for a Bun project', async () => {
    const h = harness({ '/app/package.json': pkg('bun run main.ts') });
    await h.run(['cache']);
    const out = h.out.join('\n');
    expect(out).toContain('  bun install');
    expect(out).not.toContain('deno install');
  });

  it('prints npm install for a Workers project, which carries both manifests', async () => {
    const h = harness({
      '/app/wrangler.toml': 'name = "edge"\n',
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': pkg('wrangler dev'),
    });
    await h.run(['cache']);
    expect(h.out.join('\n')).toContain('  npm install');
  });

  it('prints npm install for a hand-written Node project with no start script', async () => {
    const h = harness({
      '/app/package.json': JSON.stringify({ name: 'svc', dependencies: {} }),
      '/app/.npmrc': '@jsr:registry=https://npm.jsr.io\n',
    });
    await h.run(['cache']);
    const out = h.out.join('\n');
    expect(out).toContain('  npm install');
    expect(out).not.toContain('deno install');
  });

  it('keeps the release-day flag for a Deno project', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['cache']);
    expect(h.out.join('\n')).toContain('  deno install --min-dep-age 0');
  });

  it('warns when an npm-compat entry is written with no @jsr registry in .npmrc', async () => {
    const h = harness({ '/app/package.json': pkg('tsx main.ts') });
    await h.run(['cache']);
    expect(h.out.join('\n')).toContain('@jsr:registry=https://npm.jsr.io');
  });

  it('warns when .npmrc exists but does not route the @jsr scope', async () => {
    const h = harness({
      '/app/package.json': pkg('tsx main.ts'),
      '/app/.npmrc': 'save-exact=true\n',
    });
    await h.run(['cache']);
    expect(h.out.join('\n')).toContain('Add this line to /app/.npmrc');
  });

  it('says nothing about .npmrc when the registry line is present', async () => {
    const h = harness({
      '/app/package.json': pkg('tsx main.ts'),
      '/app/.npmrc': 'save-exact=true\n@jsr:registry=https://npm.jsr.io\n',
    });
    await h.run(['cache']);
    expect(h.out.join('\n')).not.toContain('.npmrc');
  });

  it('says nothing about .npmrc for a Deno project that carries a package.json', async () => {
    // The full-stack template on Deno: a `package.json` for the Vite build, no
    // `start` script, no `.npmrc`. `deno install` resolves `npm:@jsr/…` itself.
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': JSON.stringify({ name: 'web', scripts: { build: 'vite build' } }),
    });
    expect(await h.run(['cache'])).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('  deno install --min-dep-age 0');
    expect(out).not.toContain('.npmrc');
  });

  it('says nothing about .npmrc for a Deno project, which writes no npm entry', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['cache']);
    expect(h.out.join('\n')).not.toContain('.npmrc');
  });
});

describe('setu add — workspace roots', () => {
  const member = '/app/apps/orders/deno.json';

  for (
    const [label, files, marker] of [
      [
        'a Deno workspace key',
        { '/app/deno.json': JSON.stringify({ workspace: ['./apps/*'] }) },
        '"workspace"',
      ],
      [
        'an npm/Bun workspaces key',
        { '/app/package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }) },
        '"workspaces"',
      ],
      [
        'a setu.workspace.json',
        { '/app/deno.json': '{}', '/app/setu.workspace.json': '{}' },
        'setu.workspace.json',
      ],
    ] as const
  ) {
    it(`refuses a root marked by ${label}, writing nothing`, async () => {
      const h = harness({ ...files, [member]: DENO_MANIFEST });
      const before = Object.keys(files).map((path) => h.read(path));

      expect(await h.run(['cache'])).toBe(2);
      const err = h.err.join('\n');
      expect(err).toContain('workspace root');
      expect(err).toContain(marker);
      expect(err).toContain('--dir <member directory>');
      expect(Object.keys(files).map((path) => h.read(path))).toEqual(before);
      expect(h.read(member)).toBe(DENO_MANIFEST);
    });
  }

  it('still adds to a member when pointed at it', async () => {
    const h = harness({
      '/app/deno.json': JSON.stringify({ workspace: ['./apps/*'] }),
      [member]: DENO_MANIFEST,
    });
    expect(await h.run(['cache', '--dir', 'apps/orders'])).toBe(0);
    expect(JSON.parse(h.read(member)).imports['@setu-ts/cache-plugin']).toBeDefined();
  });
});

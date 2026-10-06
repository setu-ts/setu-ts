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
  pinnedInOtherNpmSection,
  resolveAddablePackage,
  runAddCommand,
  withDependency,
  withPluginWiring,
} from '../../../src/commands/add.ts';
import { VERSION } from '../../../src/constants.ts';
import { parseArgs } from '../../../src/args.ts';
import { listSchematics } from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';

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
      ...(devtool?.plugins ?? []),
    ],
  });
}
`;

describe('resolveAddablePackage', () => {
  it('accepts the testing package by short and full name', () => {
    expect(resolveAddablePackage('testing')).toBe('testing');
    expect(resolveAddablePackage('@setu-ts/testing')).toBe('testing');
  });
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

describe('setu add testing', () => {
  it('pins testing in the Deno import map', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['testing'])).toBe(0);
    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/testing'])
      .toBe(`jsr:@setu-ts/testing@^${VERSION}`);
  });

  for (const start of ['tsx main.ts', 'bun run main.ts']) {
    it(`uses devDependencies on the ${start} target`, async () => {
      const h = harness({ '/app/package.json': JSON.stringify({ scripts: { start } }) });
      expect(await h.run(['testing'])).toBe(0);
      const manifest = JSON.parse(h.read('/app/package.json'));
      expect(manifest.devDependencies['@setu-ts/testing'])
        .toBe(`npm:@jsr/setu-ts__testing@^${VERSION}`);
      expect(manifest.dependencies?.['@setu-ts/testing']).toBeUndefined();
    });
  }

  it('does not pin a package twice when the other npm section already holds it', async () => {
    // A scaffold may list a package in one section while `add` writes the
    // other; writing it again would pin it in both.
    const range = `npm:@jsr/setu-ts__testing@^${VERSION}`;
    const npm = JSON.stringify(
      { scripts: { start: 'tsx main.ts' }, dependencies: { '@setu-ts/testing': range } },
      null,
      2,
    );
    const h = harness({ '/app/package.json': npm });
    expect(await h.run(['testing'])).toBe(0);
    expect(h.read('/app/package.json')).toBe(npm);
    expect(h.out.join('\n')).toContain('already installed');
  });
});

describe('pinnedInOtherNpmSection', () => {
  const range = 'npm:@jsr/setu-ts__x@^1';
  it('answers only for package.json, the opposite section and the identical range', () => {
    const both = JSON.stringify({ dependencies: { x: range }, devDependencies: { y: range } });
    expect(pinnedInOtherNpmSection(both, 'package.json', 'devDependencies', 'x', range)).toBe(true);
    expect(pinnedInOtherNpmSection(both, 'package.json', 'dependencies', 'y', range)).toBe(true);
    expect(pinnedInOtherNpmSection(both, 'package.json', 'dependencies', 'x', range)).toBe(false);
    expect(pinnedInOtherNpmSection(both, 'package.json', 'devDependencies', 'x', 'other')).toBe(
      false,
    );
    expect(pinnedInOtherNpmSection(both, 'deno.json', 'devDependencies', 'x', range)).toBe(false);
    expect(pinnedInOtherNpmSection('{}', 'package.json', 'devDependencies', 'x', range)).toBe(
      false,
    );
    expect(pinnedInOtherNpmSection('{not json', 'package.json', 'dependencies', 'x', range))
      .toBe(false);
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

  it('keeps a sorted map sorted', () => {
    const updated = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/audit-plugin', 'jsr:x@^1');
    const keys = Object.keys(
      (JSON.parse(updated ?? '') as { imports: Record<string, string> }).imports,
    );
    expect(keys).toEqual([...keys].sort());
  });

  it('inserts one line after the framework group without moving existing keys', () => {
    const source = `${
      JSON.stringify(
        {
          imports: {
            '@setu-ts/common': 'common',
            '@setu-ts/kernel': 'kernel',
            '@setu-ts/runtime': 'runtime',
            '@std/expect': 'expect',
          },
        },
        null,
        2,
      )
    }\n`;
    const updated = withDependency(source, 'imports', '@setu-ts/cache-plugin', 'cache')!;
    const added = '    "@setu-ts/cache-plugin": "cache",\n';
    expect(updated.replace(added, '')).toBe(source);
  });

  it('updates an existing value in place', () => {
    const source = JSON.stringify({ imports: { z: 'old', a: 'a' } });
    expect(Object.keys(JSON.parse(withDependency(source, 'imports', 'z', 'new')!).imports))
      .toEqual(['z', 'a']);
  });

  it('appends an unscoped entry to an unsorted map', () => {
    const source = JSON.stringify({ imports: { z: 'z', a: 'a' } });
    expect(Object.keys(JSON.parse(withDependency(source, 'imports', 'b', 'b')!).imports))
      .toEqual(['z', 'a', 'b']);
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

describe('withPluginWiring', () => {
  it('preserves inline, commented and incomplete anchors, and ignores commented calls', () => {
    for (
      const source of [
        'const plugins = [...(devtool?.plugins ?? []),];',
        '// ...(devtool?.plugins ?? []),',
        '/*\n...(devtool?.plugins ?? []),\n*/',
        "'unterminated\n...(devtool?.plugins ?? []),",
      ]
    ) expect(withPluginWiring(source, 'cache-plugin')).toBeUndefined();
    const source = '// CachePlugin()\n// ...(devtool?.plugins ?? []),\n' +
      CLASS_BASED_INGRESS_CONFIG;
    const result = withPluginWiring(source, 'cache-plugin')!;
    expect(result).toContain('// ...(devtool?.plugins ?? []),\n');
    expect(result).toContain('      CachePlugin(),\n      ...(devtool?.plugins ?? []),');
  });
  // Audit L1: a plugin built once at module scope and listed by name is already
  // registered. Checking only the factory body inserted a second call, and the kernel
  // then refused the duplicate plugin name at boot.
  it('does not wire a provider the file already constructs outside the factory', () => {
    const source = "import { CachePlugin } from '@setu-ts/cache-plugin';\n" +
      'const cachePlugin = CachePlugin();\n' +
      CLASS_BASED_INGRESS_CONFIG.replace(
        '...(devtool?.plugins ?? []),',
        'cachePlugin,\n      ...(devtool?.plugins ?? []),',
      );
    expect(withPluginWiring(source, 'cache-plugin')).toBeUndefined();
  });

  // Security audit L1 (round 2): any reference is a use, not only a direct call.
  // Each spelling was a real bypass that registered the plugin twice.
  it('does not wire a provider the file already uses in any spelling', () => {
    const imported = "import { CachePlugin } from '@setu-ts/cache-plugin';\n";
    const listed = (prefix: string, item: string) =>
      prefix +
      CLASS_BASED_INGRESS_CONFIG.replace(
        '...(devtool?.plugins ?? []),',
        `${item}\n      ...(devtool?.plugins ?? []),`,
      );
    for (
      const [prefix, item] of [
        [`${imported}const cp = CachePlugin?.();\n`, 'cp,'],
        [`${imported}const cp = (0, CachePlugin)();\n`, 'cp,'],
        [`${imported}const cp = CachePlugin.call(undefined);\n`, 'cp,'],
        [`${imported}const make = CachePlugin;\n`, 'make(),'],
        ["import { CachePlugin } from './local.ts';\n", 'CachePlugin(),'],
        // Audit round 3: a second import form, a use hidden in a template
        // substitution, or a mention in a string all block the insert.
        [
          `${imported}import * as ns from '@setu-ts/cache-plugin';\nconst c = ns.CachePlugin();\n`,
          'c,',
        ],
        [
          `${imported}import * as ns from "@setu-ts/cache-plugin";\nconst c = ns.CachePlugin();\n`,
          'c,',
        ],
        [
          `${imported}const extra: unknown[] = [];\nconst t = \`\${extra.push(CachePlugin())}\`;\n`,
          '...extra,',
        ],
        [`${imported}const label = 'CachePlugin';\n`, ''],
        // Audit round 4: an escaped identifier or specifier, a `jsr:`/npm-compat
        // specifier, and any template literal (including one that hides a call
        // behind a nested opener) are refused rather than parsed.
        [imported, 'C\\u0061chePlugin(),'],
        [
          `${imported}import * as ns from '@setu-ts/cache\\u002dplugin';\nconst c = ns.CachePlugin();\n`,
          'c,',
        ],
        [
          `${imported}import * as ns from 'jsr:@setu-ts/cache-plugin@^0.8.0';\nconst c = ns.CachePlugin();\n`,
          'c,',
        ],
        [
          `${imported}import * as ns from 'npm:@jsr/setu-ts__cache-plugin@0.8.0';\nconst c = ns.CachePlugin();\n`,
          'c,',
        ],
        [`${imported}const opener = \`\${\`/*\`}\`;\nconst c = CachePlugin();\n// */\n`, 'c,'],
        // Audit round 5: a call after a U+2028/U+2029-terminated comment, behind a
        // hashbang or HTML-like comment, through a computed dynamic import, an
        // import-map alias, or in a private field — all refused.
        [`${imported}// note\u2028const c = CachePlugin();\n`, 'c,'],
        [`${imported}// note\u2029const c = CachePlugin();\n`, 'c,'],
        [`#!/* x\n${imported}const c = CachePlugin();\n// */\n`, 'c,'],
        [`${imported}<!-- /*\nconst c = CachePlugin();\n// */\n`, 'c,'],
        [
          `${imported}const ns = await import('@setu-ts/' + 'cache-plugin');\nns.CachePlugin();\n`,
          '',
        ],
        [`${imported}import * as cp from 'cachealias';\nconst c = cp.CachePlugin();\n`, 'c,'],
        [imported, 'éCachePlugin(),'],
      ] as const
    ) expect(withPluginWiring(listed(prefix, item), 'cache-plugin'), prefix).toBeUndefined();
    // Its own import is not a use, and a commented call is not one either.
    expect(withPluginWiring(listed(imported, ''), 'cache-plugin')).toContain('CachePlugin(),');
    expect(withPluginWiring(listed(imported, '// CachePlugin(),'), 'cache-plugin'))
      .toContain('      CachePlugin(),\n      ...(devtool?.plugins ?? []),');
  });

  // Audit round 4 (G-R4): refusing the insert on a possible use must not also
  // silence the guidance, or the plugin is left unregistered with nothing said.
  it('still prints registration guidance when only a string mentions the factory', async () => {
    const config = "import { CachePlugin } from '@setu-ts/cache-plugin';\n" +
      "export const note = 'see CachePlugin docs';\n" + CLASS_BASED_INGRESS_CONFIG;
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
    expect(await h.run(['cache'])).toBe(0);
    expect(h.read('/app/setu.config.ts')).toBe(config);
    expect(h.out.join('\n')).toContain('Register CachePlugin() in setu.config.ts.');
  });

  // Audit round 5 (G-R5): a string, a hashbang or a non-ASCII identifier holding
  // the registration's text left the plugin unregistered with nothing printed.
  // Each is now refused AND the guidance prints; the config is left untouched.
  it('prints guidance and leaves the config alone for refused configurations', async () => {
    const imported = "import { CachePlugin } from '@setu-ts/cache-plugin';\n";
    for (
      const config of [
        imported + "export const note = 'CachePlugin()';\n" + CLASS_BASED_INGRESS_CONFIG,
        '#! CachePlugin()\n' + imported + CLASS_BASED_INGRESS_CONFIG,
        imported + 'const éCachePlugin = () => CachePlugin;\n' + CLASS_BASED_INGRESS_CONFIG,
      ]
    ) {
      const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
      expect(await h.run(['cache']), config).toBe(0);
      expect(h.read('/app/setu.config.ts'), config).toBe(config);
      expect(h.out.join('\n'), config).toContain('Register CachePlugin() in setu.config.ts.');
    }
  });

  it('counts the package only outside comments', () => {
    // A comment naming the package is not an import; counting it refused the wire.
    const source = '// install @setu-ts/cache-plugin first\n' + CLASS_BASED_INGRESS_CONFIG;
    expect(withPluginWiring(source, 'cache-plugin')).toContain('CachePlugin(),');
  });

  it('is not satisfied by a call to a different factory whose name ends the same', () => {
    // `RedisCachePlugin()` is not a `CachePlugin()` registration; a substring
    // match left the provider unwired AND suppressed the guidance line.
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      'RedisCachePlugin(),\n      custom.CachePlugin(),\n      ...(devtool?.plugins ?? []),',
    );
    const result = withPluginWiring(source, 'cache-plugin');
    expect(result).toContain("import { CachePlugin } from '@setu-ts/cache-plugin';");
    expect(result).toContain('      CachePlugin(),\n      ...(devtool?.plugins ?? []),');
    expect(withPluginWiring(result!, 'cache-plugin')).toBeUndefined();
  });
  for (
    const [bare, symbol] of [
      ['cqrs-plugin', 'CqrsPlugin'],
      ['events-plugin', 'EventsPlugin'],
      ['messaging-plugin', 'MessagingPlugin'],
      ['queue-plugin', 'QueuePlugin'],
      ['scheduler-plugin', 'SchedulerPlugin'],
      ['websocket-plugin', 'WebSocketPlugin'],
      ['cache-plugin', 'CachePlugin'],
      ['health-plugin', 'HealthPlugin'],
      ['metrics-plugin', 'MetricsPlugin'],
      ['openapi-plugin', 'OpenApiPlugin'],
      ['sse-plugin', 'SsePlugin'],
      ['realtime-backplane-plugin', 'RealtimeBackplanePlugin'],
    ] as const
  ) {
    it(`activates ${bare} in the generated class-based ingress config`, () => {
      const updated = withPluginWiring(CLASS_BASED_INGRESS_CONFIG, bare);

      expect(updated).toContain(`import { ${symbol} } from '@setu-ts/${bare}';`);
      expect(updated).toContain(`      ${symbol}(),`);
    });
  }

  it('does not rewrite a custom decorator config or a provider it already constructs', () => {
    const custom = CLASS_BASED_INGRESS_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      '',
    );
    expect(withPluginWiring(custom, 'events-plugin')).toBeUndefined();

    const once = withPluginWiring(CLASS_BASED_INGRESS_CONFIG, 'events-plugin') ?? '';
    expect(withPluginWiring(once, 'events-plugin')).toBeUndefined();
    expect(withPluginWiring(CLASS_BASED_INGRESS_CONFIG, 'auth-plugin')).toBeUndefined();
  });

  it('uses the same anchor in a functional config', () => {
    const functional = CLASS_BASED_INGRESS_CONFIG.replace('DecoratorPlugin({', 'OtherPlugin({');
    const updated = withPluginWiring(functional, 'websocket-plugin')!;
    expect(updated).toContain('WebSocketPlugin(),\n      ...(devtool?.plugins ?? []),');
  });

  it('preserves an unfamiliar import shape', () => {
    const source =
      `import * as events from '@setu-ts/events-plugin';\n${CLASS_BASED_INGRESS_CONFIG}`;
    expect(withPluginWiring(source, 'events-plugin')).toBeUndefined();
  });

  it('reuses a provider import that exists before its plugin construction is added', () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
      "import { EventsPlugin } from '@setu-ts/events-plugin';\n" +
        "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
    );
    const updated = withPluginWiring(source, 'events-plugin') ?? '';

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
    const updated = withPluginWiring(source, 'events-plugin') ?? '';

    expect(updated).toContain(
      "import { EventsPlugin as AppEvents } from '@setu-ts/events-plugin';",
    );
    expect(updated).not.toContain("import { EventsPlugin } from '@setu-ts/events-plugin';");
    expect(updated).toContain('      AppEvents(),');
  });
});

describe('runAddCommand', () => {
  it('names every starter arm from the committed option interfaces without editing the config', async () => {
    const config =
      "import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';\nexport async function createApp() {}\n";
    let count = 0;
    for (const tier of ['rest', 'microservice', 'full-stack']) {
      const options = await Deno.readTextFile(
        new URL(`../../../../starters/${tier}-starter/src/options.ts`, import.meta.url),
      );
      for (const match of options.matchAll(/^\s+(\w+)\?: (\w+)PluginOptions;/gm)) {
        const stem = match[2]!;
        const bare = `${
          stem === 'OpenApi'
            ? 'openapi'
            : stem === 'WebSocket'
            ? 'websocket'
            : deriveNames(stem).kebab
        }-plugin`;
        const key = match[1]!;
        const arm = ['websocket', 'sse', 'backplane'].includes(key) ? `realtime.${key}` : key;
        const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
        expect(await h.run([bare]), bare).toBe(0);
        expect(h.out.join('\n'), bare).toContain(`configure its ${arm} arm`);
        // Scoped: a gated arm registers nothing until configured, so an
        // unconditional "would fail" was false for it.
        expect(h.out.join('\n'), bare).toContain(
          'Once that arm is configured, registering a second instance with app.register fails',
        );
        expect(h.read('/app/setu.config.ts')).toBe(config);
        count += 1;
      }
    }
    expect(count).toBe(34);
  });

  it('names the inherited arms on REST and microservice starters and registers unbundled plugins afterwards', async () => {
    for (
      const [pkg, symbol] of [['rest-starter', 'createRestApp'], [
        'microservice-starter',
        'createMicroserviceApp',
      ], ['full-stack-starter', 'createFullStackAppFromConfig']]
    ) {
      const config =
        `import { ${symbol} } from '@setu-ts/${pkg}';\nexport async function createApp() {}\n`;
      const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
      expect(await h.run(['auth'])).toBe(0);
      expect(h.out.join('\n')).toContain('configure its auth arm');
      const grpc = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
      expect(await grpc.run(['grpc'])).toBe(0);
      expect(grpc.out.join('\n')).toContain(
        'Register it after the factory returns: app.register(GrpcPlugin(',
      );
    }
  });

  it('preserves a Deno frontend package.json byte for byte and prints a manual line without an anchor', async () => {
    const npm = '{ "scripts": { "build": "vite build" }, "devDependencies": { "vite": "^8" } }';
    const config = 'export function createApp() { return customComposition(); }\n';
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': npm,
      '/app/setu.config.ts': config,
    });
    expect(await h.run(['cache'])).toBe(0);
    expect(h.read('/app/package.json')).toBe(npm);
    expect(h.read('/app/setu.config.ts')).toBe(config);
    expect(h.out.join('\n')).toContain('Register CachePlugin() in setu.config.ts.');
    expect(h.out.join('\n')).not.toContain('starter');
  });

  it('prints concrete configuration guidance for providers requiring application choices', async () => {
    for (
      const [pkg, factory] of [
        ['database', 'DatabasePlugin'],
        ['feature-flags', 'FeatureFlagsPlugin'],
        ['notification', 'NotificationPlugin'],
        ['graphql', 'GraphqlPlugin'],
        ['static', 'StaticPlugin'],
        ['react-router', 'ReactRouterPlugin'],
        ['multi-tenancy', 'MultiTenancyPlugin'],
        ['service-discovery', 'ServiceDiscoveryPlugin'],
      ]
    ) {
      const h = harness({ '/app/deno.json': DENO_MANIFEST });
      expect(await h.run([pkg!]), h.err.join('\n')).toBe(0);
      expect(h.out.join('\n')).toContain(`Register ${factory}({`);
    }
    const worker = harness({ '/app/deno.json': DENO_MANIFEST, '/app/wrangler.jsonc': '{}' });
    expect(await worker.run(['cloudflare']), worker.err.join('\n')).toBe(0);
    expect(worker.out.join('\n')).toContain('Register CloudflarePlugin({ env })');
  });

  it('prints only registrations that type-check against their plugin option types', async () => {
    // The fixture is reached by `deno check packages`, so each line it carries
    // compiles against the real option type; this test pins that every printed
    // line IS one of them, verbatim.
    const fixture = await Deno.readTextFile(
      new URL('../../fixtures/registration-lines.ts', import.meta.url),
    );
    const printed: string[] = [];
    for (
      const pkg of [
        'auth',
        'session',
        'grpc',
        'database',
        'feature-flags',
        'notification',
        'graphql',
        'static',
        'react-router',
        'multi-tenancy',
        'service-discovery',
        'cloudflare',
      ]
    ) {
      const h = harness({
        '/app/deno.json': DENO_MANIFEST,
        ...(pkg === 'cloudflare' ? { '/app/wrangler.jsonc': '{}' } : {}),
      });
      expect(await h.run([pkg]), h.err.join('\n')).toBe(0);
      const line = /Register (.+) in setu\.config\.ts\./.exec(h.out.join('\n'))?.[1];
      expect(line, `no registration printed for ${pkg}`).toBeDefined();
      printed.push(line!);
    }
    for (const line of printed) expect(fixture).toContain(`  ${line},`);
    // The guard schematic composes requirePermission, which answers 501 unless
    // AuthPlugin registers an authorization service — so the auth line must
    // carry the rbac arm, not just jwt.
    expect(printed[0]).toBe(
      "AuthPlugin({ jwt: { secret: '<your-secret>' }, rbac: { roles: {} } })",
    );
  });

  // Audit round 6 (T-R6): the CLI's own rewrite `RealtimeBackplanePlugin({ ...sources.backplane })`
  // was refused on the next run, so the backplane row vanished from the managed module while
  // the configuration still read it — a TS2339 produced entirely by CLI commands.
  it('keeps the backplane row across a later add', async () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      'export function createApp() {',
      `export function createApp(\n  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n): IKernelApplication {`,
    );
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': source,
      '/app/src/devtool/diagnostics.ts': 'old managed module',
    });
    expect(await h.run(['realtime-backplane'])).toBe(0);
    expect(h.read('/app/setu.config.ts')).toContain(
      'RealtimeBackplanePlugin({ ...sources.backplane })',
    );
    expect(h.read('/app/src/devtool/diagnostics.ts')).toContain('  backplane: {');
    expect(await h.run(['cache'])).toBe(0);
    expect(h.read('/app/src/devtool/diagnostics.ts')).toContain('  backplane: {');
    expect(h.read('/app/src/devtool/diagnostics.ts')).toContain('  cache: {');
  });

  // Audit round 6 (L1-R5): a starter, or an import map pointing a framework name
  // elsewhere, registers plugins the configuration never names; inserting another
  // is a duplicate plugin name at boot.
  it('never inserts beside a starter import or a retargeted import map', async () => {
    const starter = "import { buildRestPlugins } from '@setu-ts/rest-starter';\n" +
      CLASS_BASED_INGRESS_CONFIG.replace(
        'DecoratorPlugin({',
        '...buildRestPlugins(),\n      DecoratorPlugin({',
      );
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': starter });
    expect(await h.run(['health'])).toBe(0);
    expect(h.read('/app/setu.config.ts')).toBe(starter);
    expect(h.out.join('\n')).toContain('createRestApp owns this plugin');

    const manifest = JSON.stringify({
      imports: {
        '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^1',
        '@setu-ts/health-plugin': 'jsr:@setu-ts/cache-plugin@^1',
      },
    });
    const remapped = harness({
      '/app/deno.json': manifest,
      '/app/setu.config.ts': CLASS_BASED_INGRESS_CONFIG,
    });
    expect(await remapped.run(['cache'])).toBe(0);
    expect(remapped.read('/app/setu.config.ts')).toBe(CLASS_BASED_INGRESS_CONFIG);
    expect(remapped.out.join('\n')).toContain('Register CachePlugin() in setu.config.ts.');
  });

  // Audit round 6 (G-R6): a declaration sharing the factory's name is not a call,
  // and a call outside createApp does not register anything createApp builds.
  it('prints guidance when the only match is a declaration', async () => {
    const imported = "import { CachePlugin } from '@setu-ts/cache-plugin';\n";
    for (
      const extra of [
        'const docs = { CachePlugin() { return 1; } };\n',
        'class Docs { CachePlugin() { return 1; } }\n',
        'interface Docs { CachePlugin(): string }\n',
        'function helper() { return CachePlugin(); }\n',
      ]
    ) {
      const config = imported + extra + CLASS_BASED_INGRESS_CONFIG;
      const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
      expect(await h.run(['cache']), extra).toBe(0);
      expect(h.out.join('\n'), extra).toContain('Register CachePlugin() in setu.config.ts.');
    }
  });

  // Audit round 6 (R-R6): the import-item split was quadratic in a run of spaces.
  it('parses a hostile import item in linear time', async () => {
    const config =
      `import { CachePlugin as${' '.repeat(150_000)}AppCache } from '@setu-ts/cache-plugin';\n` +
      CLASS_BASED_INGRESS_CONFIG;
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
    const started = performance.now();
    expect(await h.run(['cache'])).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('refreshes an opted-in source module and gates the newly wired plugin', async () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      'export function createApp() {',
      `export function createApp(\n  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n): IKernelApplication {`,
    );
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': source,
      '/app/src/devtool/diagnostics.ts': 'old managed module',
    });
    expect(await h.run(['cache'])).toBe(0);
    expect(h.read('/app/src/devtool/diagnostics.ts')).toContain('CacheDiagnosticsOptions');
    expect(h.read('/app/setu.config.ts')).toContain('...sources.cache');
    expect(h.out.join('\n')).not.toContain('Register CachePlugin');
    const noDevtool = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await noDevtool.run(['cache'])).toBe(0);
    expect(noDevtool.fs.has('/app/src/devtool/diagnostics.ts')).toBe(false);
  });
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
      '/app/package.json': JSON.stringify(
        { name: 'edge', scripts: { start: 'tsx main.ts' }, dependencies: {} },
        null,
        2,
      ),
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

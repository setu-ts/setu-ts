import { cliInvocation } from '../../../src/templates/project-files.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * Tests for `setu add <plugin>` (D3).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  addableNames,
  addSeam,
  pinnedInOtherNpmSection,
  resolveAddablePackage,
  runAddCommand,
  withDependency,
  withPluginWiring,
} from '../../../src/commands/add.ts';
import { VERSION } from '../../../src/constants.ts';
import { parseArgs } from '../../../src/args.ts';
import { runNewCommand } from '../../../src/commands/new.ts';
import { listSchematics } from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { EVENTS_SEAM } from '../../../src/seams/events.ts';
import { COMMAND_HANDLER_SEAM } from '../../../src/seams/cqrs.ts';
import { runCli } from '../../../src/cli.ts';
import { CLIENT_RANGES } from '../../../src/templates/client-dependencies.ts';
import { listTransports } from '../../../src/workspace/transport.ts';

describe('M121 transport additions', () => {
  // PR #519 review: guidance reads the starter's actual option and the provider's actual call.
  it('reports a full-stack option the factory already sets instead of the memory default', async () => {
    const h = harness();
    expect(
      await runNewCommand(parseArgs(['shop', '--template', 'full-stack', '--runtime', 'node']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: (line) => h.err.push(line),
      }),
    ).toBe(0);
    expect(await h.run(['messaging', '--dir', '/app/shop'])).toBe(0);
    expect(h.out.join('\n')).toContain('already registers messaging in memory by default');
    expect(await h.run(['messaging', '--broker', 'redis', '--dir', '/app/shop'])).toBe(0);
    for (const flags of [[], ['--broker', 'memory']]) {
      h.out.length = 0;
      expect(await h.run(['messaging', ...flags, '--dir', '/app/shop'])).toBe(0);
      const out = h.out.join('\n');
      expect(out).toContain('setu.config.ts already sets its own messaging option');
      expect(out).not.toContain('in memory by default');
    }
  });
  it('does not take an unrelated object with the same literal for the configured call', async () => {
    const source = `import { MessagingPlugin } from '@setu-ts/messaging-plugin';
const unrelated = { broker: 'redis-streams', url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' };
export function createApp(): IKernelApplication {
  return createApplication({ plugins: [MessagingPlugin(), ...(devtool?.plugins ?? [])] });
}
`;
    const h = harness({
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/messaging-plugin': `^${VERSION}` },
      }),
      '/app/setu.config.ts': source,
    });
    expect(await h.run(['messaging', '--broker', 'redis'])).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('Set MessagingPlugin(');
    expect(out).not.toContain('already passes these options');
  });
  // PR #519 review: an existing Compose file is never rewritten, and a selected service it
  // lacks is printed rather than silently skipped.
  it('prints the service an existing Compose file lacks, and nothing when it has it', async () => {
    const h = harness();
    expect(
      await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', 'node']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: (line) => h.err.push(line),
      }),
    ).toBe(0);
    expect(await h.run(['messaging', '--broker', 'redis', '--dir', '/app/shop'])).toBe(0);
    const compose = h.read('/app/shop/docker/compose.yaml');
    expect(compose).toContain('  redis:');

    h.out.length = 0;
    expect(await h.run(['queue', '--queue', 'rabbitmq', '--dir', '/app/shop'])).toBe(0);
    expect(h.read('/app/shop/docker/compose.yaml')).toBe(compose);
    const out = h.out.join('\n');
    expect(out).toContain('docker/compose.yaml exists and has no rabbitmq service');
    expect(out).toContain('  rabbitmq:');

    h.out.length = 0;
    expect(await h.run(['queue', '--queue', 'redis', '--dir', '/app/shop'])).toBe(0);
    expect(h.out.join('\n')).not.toContain('has no redis service');
  });
  // PR #519 review: guidance must not ask for the option this run just wrote, and must
  // still name the value when an existing one was preserved.
  for (const template of ['rest', 'full-stack'] as const) {
    it(`prints no wiring note after writing the transport into a ${template} config`, async () => {
      const h = harness();
      expect(
        await runNewCommand(parseArgs(['shop', '--template', template, '--runtime', 'node']), {
          fs: h.fs,
          cwd: '/app',
          log: () => {},
          error: (line) => h.err.push(line),
        }),
      ).toBe(0);
      expect(await h.run(['messaging', '--broker', 'redis', '--dir', '/app/shop'])).toBe(0);
      const written = h.out.join('\n');
      expect(h.read('/app/shop/setu.config.ts')).toContain("broker: 'redis-streams'");
      expect(written).not.toContain('In setu.config.ts:');
      expect(written).not.toContain('Set MessagingPlugin(');

      // A re-run finds the identical value and says so instead of asking for it again.
      h.out.length = 0;
      expect(await h.run(['messaging', '--broker', 'redis', '--dir', '/app/shop'])).toBe(0);
      const rerun = h.out.join('\n');
      expect(rerun).toContain('setu.config.ts already ');
      expect(rerun).not.toMatch(/Set MessagingPlugin\(|In setu\.config\.ts: messaging: /);

      // A different existing value is preserved and the wanted value is named.
      h.out.length = 0;
      expect(await h.run(['messaging', '--broker', 'nats', '--dir', '/app/shop'])).toBe(0);
      expect(h.out.join('\n')).toMatch(
        template === 'rest'
          ? /Set MessagingPlugin\(\{/
          : /existing messaging option was preserved; to use this transport, set:\n {2}messaging: \{/,
      );
      expect(h.read('/app/shop/setu.config.ts')).not.toContain("broker: 'nats'");
    });
  }
  for (const runtime of ['node', 'deno'] as const) {
    for (const template of ['rest', 'microservice', 'full-stack']) {
      for (const transport of ['redis', 'nats']) {
        it(`uses ${transport} for ${runtime} ${template} workspace additions`, async () => {
          const h = harness();
          const cli = (args: readonly string[]) =>
            runCli(args, {
              fs: h.fs,
              cwd: '/app',
              now: () => 0,
              log: (m) => h.out.push(m),
              error: (m) => h.err.push(m),
            });
          expect(
            await cli(['new', 'ws', '--workspace', '--runtime', runtime, '--transport', transport]),
          ).toBe(0);
          if (runtime === 'deno') {
            const path = '/app/ws/deno.json';
            const manifest = JSON.parse(h.read(path)) as Record<string, unknown>;
            await h.fs.writeFile(
              path,
              new TextEncoder().encode(JSON.stringify({ ...manifest, nodeModulesDir: 'auto' })),
            );
          }
          expect(
            await cli(['g', 'app', 'api', '--template', template, '--dir', '/app/ws']),
            h.err.join('\n'),
          ).toBe(0);
          const dir = '/app/ws/apps/api';
          for (const plugin of ['messaging', 'queue'])
            expect(await h.run([plugin, '--dir', dir]), h.err.join('\n')).toBe(0);
          const config = h.read(`${dir}/setu.config.ts`);
          const client = transport === 'redis' ? 'ioredis' : 'nats';
          const manifest = h.read(`${dir}/${runtime === 'deno' ? 'deno.json' : 'package.json'}`);
          expect(manifest).toContain(client);
          if (runtime === 'node') expect(h.read('/app/ws/package.json')).toContain(client);
          if (template === 'rest') {
            // Existing calls are preserved. REST has neither provider originally.
            expect(config).toContain(
              `broker: '${transport === 'redis' ? 'redis-streams' : 'nats'}'`,
            );
          } else if (template === 'full-stack') {
            expect(config).toContain('messaging: {');
            expect(config).toContain('config.get<string>(');
            expect(config.includes('queue: {')).toBe(transport === 'redis');
          } else {
            // Generated with the workspace transport, so a re-add finds it already set.
            expect(h.out.join('\n')).toContain('already passes these options to MessagingPlugin');
            expect(h.out.join('\n')).not.toContain('existing call was preserved');
          }
          expect(config).not.toContain("QueuePlugin({ adapter: 'nats'");
        });
      }
    }
    for (const spec of listTransports().filter((arm) => arm.connection !== undefined)) {
      for (const flag of ['broker', 'queue'] as const) {
        if ((flag === 'broker' ? spec.messagingArgs : spec.queueArgs) === undefined) continue;
        it(`adds standalone ${runtime} ${flag} ${spec.name} and preserves Compose and dotenv on re-add`, async () => {
          const h = harness();
          expect(
            await runNewCommand(
              parseArgs(['portal', '--runtime', runtime, '--template', 'full-stack']),
              { fs: h.fs, cwd: '/app', log: () => {}, error: () => {} },
            ),
          ).toBe(0);
          const env = h.read('/app/portal/.env');
          const args = [
            flag === 'broker' ? 'messaging' : 'queue',
            `--${flag}`,
            spec.name,
            '--dir',
            '/app/portal',
          ];
          const beforeDryRun = h.fs.writes.length;
          expect(await h.run([...args, '--dry-run'])).toBe(0);
          expect(h.fs.writes.length).toBe(beforeDryRun);
          expect(h.out.join('\n')).toContain('docker/compose.yaml');
          expect(h.out.join('\n')).toContain('setu.config.ts');
          expect(await h.run(args), h.err.join('\n')).toBe(0);
          const config = h.read('/app/portal/setu.config.ts');
          expect(config).toContain(`${flag === 'broker' ? 'messaging' : 'queue'}: {`);
          const manifest = h.read(
            `/app/portal/${runtime === 'deno' ? 'deno.json' : 'package.json'}`,
          );
          for (const client of (flag === 'broker' ? spec.messagingClients : spec.queueClients) ??
            [])
            expect(manifest).toContain(client);
          expect(h.read('/app/portal/.env')).toBe(env);
          const compose = h.read('/app/portal/docker/compose.yaml');
          const beforeReAdd = h.fs.writes.length;
          expect(await h.run(args)).toBe(0);
          expect(h.read('/app/portal/setu.config.ts')).toBe(config);
          expect(h.read('/app/portal/docker/compose.yaml')).toBe(compose);
          expect(h.fs.writes.length).toBe(beforeReAdd);
          expect(h.out.join('\n')).toContain(
            `${spec.connection!.variable}=${spec.connection!.localDefault}`,
          );
        });
      }
    }
  }

  for (const args of [
    ['cache', '--broker', 'redis'],
    ['cache', '--queue', 'redis'],
    ['messaging', '--queue', 'redis'],
    ['queue', '--broker', 'redis'],
    ['messaging', '--broker'],
    ['messaging', '--broker', 'unknown'],
    ['queue', '--queue', 'nats'],
    ['messaging', '--broker', 'http'],
  ]) {
    it(`refuses ${args.join(' ')} without writing`, async () => {
      const h = harness({ '/app/package.json': '{}' });
      expect(await h.run(args)).toBe(2);
      expect(h.fs.writes).toEqual([]);
      expect(h.err.join('\n')).toContain('--');
    });
  }
  for (const flag of ['broker', 'queue'] as const) {
    it(`refuses --${flag} on Workers`, async () => {
      const h = harness({ '/app/package.json': '{}', '/app/wrangler.toml': '' });
      expect(await h.run([flag === 'broker' ? 'messaging' : 'queue', `--${flag}`, 'redis'])).toBe(
        2,
      );
      expect(h.err.join('\n')).toContain('Cloudflare Workers');
      expect(h.fs.writes).toEqual([]);
    });
    it(`refuses --${flag} in a workspace member`, async () => {
      const h = harness();
      const cli = (args: readonly string[]) =>
        runCli(args, { fs: h.fs, cwd: '/app', now: () => 0, log: () => {}, error: () => {} });
      expect(await cli(['new', 'ws', '--workspace'])).toBe(0);
      expect(await cli(['g', 'app', 'api', '--dir', '/app/ws'])).toBe(0);
      const before = h.fs.writes.length;
      expect(
        await h.run([
          flag === 'broker' ? 'messaging' : 'queue',
          `--${flag}`,
          'redis',
          '--dir',
          '/app/ws/apps/api',
        ]),
      ).toBe(2);
      expect(h.err.join('\n')).toContain('workspace --transport');
      expect(h.fs.writes.length).toBe(before);
    });
  }
  it('accepts explicit memory without a connection or Compose file', async () => {
    const h = harness({ '/app/package.json': '{}' });
    expect(await h.run(['messaging', '--broker', 'memory'])).toBe(0);
    expect(await h.run(['queue', '--queue', 'memory'])).toBe(0);
    expect(h.fs.writes).toEqual([
      '/app/package.json',
      '/app/package.json',
      '/app/src/jobs/index.ts',
    ]);
  });
  // A starter with a messaging arm gets the property; createRestApp has none
  // (RestStarterOptions), so it gets the after-factory registration (M121 §3.7).
  for (const [pkg, symbol, shape] of [
    ['rest', 'createRestApp', 'app.register(MessagingPlugin({'],
    ['microservice', 'createMicroserviceApp', 'messaging: {'],
    ['full-stack', 'createFullStackAppFromConfig', 'messaging: {'],
  ]) {
    it(`prints the ${pkg} starter's own registration for a hand-written config`, async () => {
      const source = `import { ${symbol} } from '@setu-ts/${pkg}-starter';\nexport async function createApp() { return ${symbol}({}); }\n`;
      const h = harness({ '/app/package.json': '{}', '/app/setu.config.ts': source });
      expect(await h.run(['messaging', '--broker', 'redis'])).toBe(0);
      expect(h.read('/app/setu.config.ts')).toBe(source);
      const out = h.out.join('\n');
      expect(out).toContain(shape!);
      expect(out).toContain("broker: 'redis-streams'");
      if (pkg === 'rest') expect(out).not.toContain('messaging: {');
    });
  }
  it('refuses react-router before writing and accepts a full-stack project', async () => {
    const h = harness({ '/app/package.json': '{}' });
    expect(await h.run(['react-router'])).toBe(1);
    expect(h.err.join('\n')).toContain(
      `Run ${cliInvocation('node')} new <name> --template full-stack.`,
    );
    expect(h.fs.writes).toEqual([]);
    expect(
      await runNewCommand(parseArgs(['portal', '--template', 'full-stack']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: () => {},
      }),
    ).toBe(0);
    expect(await h.run(['react-router', '--dir', '/app/portal'])).toBe(0);
  });
  it('keeps an existing inline ReactRouterPlugin installed', async () => {
    const config =
      "import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';\nexport function createApp() { const app = makeApp(); app.register(ReactRouterPlugin({ serverBuildPath: 'build.js' })); return app; }\n";
    const h = harness({
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/react-router-plugin': `^${VERSION}` },
      }),
      '/app/setu.config.ts': config,
    });
    expect(await h.run(['react-router'])).toBe(0);
    expect(h.fs.writes).toEqual([]);
  });
  it('refuses react-router in a non-full-stack workspace with the member creation command', async () => {
    const h = harness();
    const cli = (args: readonly string[]) =>
      runCli(args, { fs: h.fs, cwd: '/app', now: () => 0, log: () => {}, error: () => {} });
    expect(await cli(['new', 'ws', '--workspace'])).toBe(0);
    expect(await cli(['g', 'app', 'api', '--dir', '/app/ws'])).toBe(0);
    const before = h.fs.writes.length;
    expect(await h.run(['react-router', '--dir', '/app/ws/apps/api'])).toBe(1);
    expect(h.err.join('\n')).toContain(
      `Run ${cliInvocation('node')} generate app <name> --template full-stack.`,
    );
    expect(h.fs.writes.length).toBe(before);
  });
});

describe('safe-default additions (M119c)', () => {
  for (const runtime of ['node', 'bun', 'deno']) {
    it(`installs only the four console telemetry peers on ${runtime}`, async () => {
      const h = harness();
      expect(
        await runNewCommand(parseArgs(['api', '--runtime', runtime]), {
          fs: h.fs,
          cwd: '/app',
          log: (m) => h.out.push(m),
          error: (m) => h.err.push(m),
        }),
      ).toBe(0);
      expect(await h.run(['telemetry', '--dir', '/app/api'])).toBe(0);
      const file = runtime === 'deno' ? 'deno.json' : 'package.json';
      const manifest = JSON.parse(h.read(`/app/api/${file}`)) as Record<
        string,
        Record<string, string>
      >;
      const deps = manifest[runtime === 'deno' ? 'imports' : 'dependencies']!;
      const peers = Object.keys(deps).filter((name) => name.startsWith('@opentelemetry/'));
      expect(peers.sort()).toEqual([
        '@opentelemetry/api',
        '@opentelemetry/context-async-hooks',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace-base',
      ]);
      for (const name of peers) {
        expect(deps[name]).toBe(
          runtime === 'deno' ? `npm:${name}@${CLIENT_RANGES[name]}` : CLIENT_RANGES[name],
        );
      }
    });
  }

  it('preserves an existing telemetry peer pin', async () => {
    const h = harness({
      '/app/package.json': JSON.stringify({ dependencies: { '@opentelemetry/api': '1.9.1' } }),
    });
    expect(await h.run(['telemetry'])).toBe(0);
    expect(
      (JSON.parse(h.read('/app/package.json')) as { dependencies: Record<string, string> })
        .dependencies['@opentelemetry/api'],
    ).toBe('1.9.1');
  });

  for (const transport of ['redis', 'nats', 'http']) {
    for (const runtime of ['node', 'deno']) {
      it(`uses the ${transport} workspace transport on ${runtime} and configures scheduler locks`, async () => {
        const h = harness();
        const cli = (args: readonly string[]) =>
          runCli(args, {
            fs: h.fs,
            cwd: '/app',
            now: () => 0,
            log: (m) => h.out.push(m),
            error: (m) => h.err.push(m),
          });
        expect(
          await cli(['new', 'ws', '--workspace', '--runtime', runtime, '--transport', transport]),
        ).toBe(0);
        expect(await cli(['g', 'app', 'api', '--dir', '/app/ws'])).toBe(0);
        for (const plugin of ['cache', 'scheduler', 'realtime-backplane']) {
          expect(await h.run([plugin, '--dir', '/app/ws/apps/api'])).toBe(0);
        }
        const config = h.read('/app/ws/apps/api/setu.config.ts');
        if (transport === 'redis') {
          expect(config).toContain("store: 'redis'");
          expect(config).toContain("storage: 'redis'");
          expect(config).toContain("transport: 'redis'");
          expect(config).toContain(
            runtime === 'deno' ? "Deno.env.get('REDIS_URL')" : 'process.env.REDIS_URL',
          );
          const manifest = h.read(
            `/app/ws/apps/api/${runtime === 'deno' ? 'deno.json' : 'package.json'}`,
          );
          expect(manifest).toContain('ioredis');
        } else {
          expect(config).toContain('CachePlugin()');
          expect(config).toContain('RealtimeBackplanePlugin()');
          expect(config).not.toContain('distributedLock');
        }
      });
    }
  }
});

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
      runAddCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        log: (m) => out.push(m),
        error: (m) => err.push(m),
      }),
  };
}

describe('setu add — optional peers in a Setu workspace (M119f)', () => {
  const peers = [
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
  ];
  async function workspace(runtime = 'node') {
    const h = harness();
    const cli = (args: readonly string[]) =>
      runCli(args, {
        fs: h.fs,
        cwd: '/app',
        now: () => 0,
        log: (message) => h.out.push(message),
        error: (message) => h.err.push(message),
      });
    expect(await cli(['new', 'ws', '--workspace', '--runtime', runtime])).toBe(0);
    expect(await cli(['g', 'app', 'api', '--dir', '/app/ws'])).toBe(0);
    h.out.length = 0;
    return h;
  }
  const put = (h: ReturnType<typeof harness>, path: string, text: string) =>
    h.fs.writeFile(path, new TextEncoder().encode(text));
  const dependencies = (h: ReturnType<typeof harness>, path: string) =>
    (JSON.parse(h.read(path)) as { dependencies: Record<string, string> }).dependencies;

  for (const runtime of ['node', 'bun']) {
    it(`records the same console peers in root and member dependencies on ${runtime}, idempotently`, async () => {
      const h = await workspace(runtime);
      expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
      for (const path of ['/app/ws/package.json', '/app/ws/apps/api/package.json']) {
        const deps = dependencies(h, path);
        for (const peer of peers) expect(deps[peer], path).toBe(CLIENT_RANGES[peer]);
        expect(h.out.join('\n')).toContain(`updated ${path}`);
      }
      expect(dependencies(h, '/app/ws/package.json')['@setu-ts/telemetry-plugin']).toBeUndefined();
      const writes = h.fs.writes.length;
      expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
      expect(h.fs.writes.length).toBe(writes);
    });
  }

  it('preserves existing root peer pins while adding missing peers, even on re-add', async () => {
    const h = await workspace();
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        dependencies: { '@opentelemetry/api': '1.9.1' },
      }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(dependencies(h, '/app/ws/package.json')['@opentelemetry/api']).toBe('1.9.1');
    for (const peer of peers.slice(1)) {
      expect(dependencies(h, '/app/ws/package.json')[peer]).toBe(CLIENT_RANGES[peer]);
    }
  });

  it('records a root-overridden peer at the override spec, so npm installs it without EOVERRIDE', async () => {
    const h = await workspace();
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        overrides: {
          // A string value and an object's "." entry pin the peer itself:
          // npm accepts a direct dependency only at the override's exact spec.
          '@opentelemetry/api': '1.9.1',
          '@opentelemetry/resources': { '.': '2.9.0' },
          // Overrides only a CHILD of the peer, not the peer: the CLI range applies.
          '@opentelemetry/sdk-trace-base': { '@opentelemetry/core': '2.0.0' },
          // A reference to a root dependency that does not exist: not a usable spec.
          '@opentelemetry/context-async-hooks': '$@opentelemetry/context-async-hooks',
        },
      }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    const root = dependencies(h, '/app/ws/package.json');
    expect(root['@opentelemetry/api']).toBe('1.9.1');
    expect(root['@opentelemetry/resources']).toBe('2.9.0');
    expect(root['@opentelemetry/sdk-trace-base']).toBe(
      CLIENT_RANGES['@opentelemetry/sdk-trace-base'],
    );
    expect(root['@opentelemetry/context-async-hooks']).toBeUndefined();
    // The member keeps the CLI ranges even where they differ from the root
    // override (`~1.9.0` against `1.9.1`): the root entry is what places one copy.
    for (const peer of peers) {
      expect(dependencies(h, '/app/ws/apps/api/package.json')[peer]).toBe(CLIENT_RANGES[peer]);
    }
    const out = h.out.join('\n');
    expect(out).toContain('left @opentelemetry/context-async-hooks out of /app/ws/package.json');
    expect(out).not.toContain('left @opentelemetry/api');
  });

  it('leaves a peer pinned by a version-selector override to the user, writing nothing for it', async () => {
    const h = await workspace();
    // Measured with npm 11: whether `name@<range>` applies depends on the version
    // chosen — `~1.9.0` beside `@opentelemetry/api@1` is refused (EOVERRIDE), and
    // `1.9.1` beside `@opentelemetry/api@2` is refused too — so neither spec is safe.
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({ workspaces: ['apps/*'], overrides: { '@opentelemetry/api@1': '1.9.1' } }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    const root = dependencies(h, '/app/ws/package.json');
    expect(root['@opentelemetry/api']).toBeUndefined();
    expect(root['@opentelemetry/resources']).toBe(CLIENT_RANGES['@opentelemetry/resources']);
    expect(h.out.join('\n')).toContain(
      'left @opentelemetry/api out of /app/ws/package.json: its "overrides" pins it only for some versions',
    );
  });

  it('treats several override rules for one peer as conditional, whatever their order', async () => {
    for (const overrides of [
      { '@opentelemetry/resources@1': '1.30.0', '@opentelemetry/resources@2': '2.9.0' },
      { '@opentelemetry/resources': '2.9.0', '@opentelemetry/resources@1': '1.30.0' },
      { '@opentelemetry/resources@1': '1.30.0', '@opentelemetry/resources': '2.9.0' },
    ]) {
      const h = await workspace();
      await put(h, '/app/ws/package.json', JSON.stringify({ workspaces: ['apps/*'], overrides }));
      expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
      expect(dependencies(h, '/app/ws/package.json')['@opentelemetry/resources']).toBeUndefined();
      expect(h.out.join('\n')).toContain(
        'left @opentelemetry/resources out of /app/ws/package.json: its "overrides" pins it only for some versions',
      );
    }
  });

  it('moves a dev-only peer pin to dependencies and keeps an optional one, root and member', async () => {
    const h = await workspace();
    // `npm install --omit=dev` drops devDependencies, so a runtime peer declared
    // only there is moved, pin unchanged; optionalDependencies survive it.
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        devDependencies: { '@opentelemetry/api': '1.9.0', prettier: '^3' },
        optionalDependencies: { '@opentelemetry/resources': '2.9.0' },
      }),
    );
    const member = JSON.parse(h.read('/app/ws/apps/api/package.json')) as Record<string, unknown>;
    await put(
      h,
      '/app/ws/apps/api/package.json',
      JSON.stringify({ ...member, devDependencies: { '@opentelemetry/api': '1.9.0' } }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    for (const path of ['/app/ws/package.json', '/app/ws/apps/api/package.json']) {
      const manifest = JSON.parse(h.read(path)) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(manifest.dependencies['@opentelemetry/api'], path).toBe('1.9.0');
      expect(manifest.devDependencies['@opentelemetry/api'], path).toBeUndefined();
      expect(h.out.join('\n')).toContain(
        `moved @opentelemetry/api from devDependencies to dependencies in ${path}`,
      );
    }
    const root = JSON.parse(h.read('/app/ws/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Unrelated development pins stay where they are.
    expect(root.devDependencies['prettier']).toBe('^3');
    expect(root.dependencies['@opentelemetry/resources']).toBeUndefined();
    expect(root.dependencies['@opentelemetry/sdk-trace-base']).toBe(
      CLIENT_RANGES['@opentelemetry/sdk-trace-base'],
    );
  });

  it('keeps the root entry at the CLI range and names a member pinned at another spec', async () => {
    const h = await workspace();
    // The root entry is what keeps the hoisted framework package inside its peer
    // range; measured with npm 11, a member at 5.4.1 beside it keeps a second
    // copy, so the CLI says so instead of staying silent.
    const member = JSON.parse(h.read('/app/ws/apps/api/package.json')) as {
      dependencies: Record<string, string>;
    };
    await put(
      h,
      '/app/ws/apps/api/package.json',
      JSON.stringify({
        ...member,
        dependencies: { ...member.dependencies, '@opentelemetry/api': '1.9.0' },
      }),
    );
    const manifest = JSON.parse(h.read('/app/ws/setu.workspace.json')) as {
      members: Record<string, unknown>[];
    };
    const worker = { ...manifest.members[0]!, name: 'worker', port: 4999 };
    await put(
      h,
      '/app/ws/setu.workspace.json',
      JSON.stringify({ ...manifest, members: [...manifest.members, worker] }),
    );
    await put(
      h,
      '/app/ws/apps/worker/package.json',
      JSON.stringify({
        name: 'worker',
        // A sibling's dev pin is installed too, and so splits the copy as well.
        devDependencies: { '@opentelemetry/resources': '2.9.0' },
        // Equal to the CLI range: no conflict, so the root entry is still written.
        dependencies: {
          '@opentelemetry/sdk-trace-base': CLIENT_RANGES['@opentelemetry/sdk-trace-base'],
        },
      }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    const root = dependencies(h, '/app/ws/package.json');
    for (const peer of peers) expect(root[peer], peer).toBe(CLIENT_RANGES[peer]);
    // The member keeps its own pin.
    expect(dependencies(h, '/app/ws/apps/api/package.json')['@opentelemetry/api']).toBe('1.9.0');
    const out = h.out.join('\n');
    expect(out).toContain(
      'note: /app/ws/apps/api/package.json pins @opentelemetry/api at 1.9.0; the root entry keeps',
    );
    expect(out).toContain(
      '/app/ws/apps/worker/package.json pins @opentelemetry/resources at 2.9.0',
    );
    // A sibling pinned at exactly the CLI range is no conflict and draws no note.
    expect(out).not.toContain('pins @opentelemetry/sdk-trace-base');
  });

  it('treats a peerDependencies pin as present, root and member', async () => {
    const h = await workspace();
    // Measured with npm 11 and Bun 1.4: both install a project's own peer entry,
    // so a dependencies entry beside it would replace its pin.
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        peerDependencies: { '@opentelemetry/api': '1.9.0' },
      }),
    );
    const member = JSON.parse(h.read('/app/ws/apps/api/package.json')) as Record<string, unknown>;
    await put(
      h,
      '/app/ws/apps/api/package.json',
      JSON.stringify({ ...member, peerDependencies: { '@opentelemetry/resources': '2.9.0' } }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    const root = JSON.parse(h.read('/app/ws/package.json')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(root.dependencies['@opentelemetry/api']).toBeUndefined();
    expect(root.peerDependencies['@opentelemetry/api']).toBe('1.9.0');
    expect(
      dependencies(h, '/app/ws/apps/api/package.json')['@opentelemetry/resources'],
    ).toBeUndefined();
  });

  it('adds an optional peer declaration to dependencies at its own spec, keeping the declaration', async () => {
    const h = await workspace();
    // Measured with npm 11 and Bun 1.4: a peer marked optional in
    // peerDependenciesMeta installs nothing, so it is not yet a dependency.
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        peerDependencies: { '@opentelemetry/api': '1.9.0' },
        peerDependenciesMeta: { '@opentelemetry/api': { optional: true } },
      }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    const root = JSON.parse(h.read('/app/ws/package.json')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(root.dependencies['@opentelemetry/api']).toBe('1.9.0');
    expect(root.peerDependencies['@opentelemetry/api']).toBe('1.9.0');
  });

  it('reads a root package.json that starts with a byte-order mark', async () => {
    const h = await workspace();
    await put(h, '/app/ws/package.json', `\uFEFF${JSON.stringify({ workspaces: ['apps/*'] })}`);
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    for (const peer of peers) {
      expect(dependencies(h, '/app/ws/package.json')[peer]).toBe(CLIENT_RANGES[peer]);
    }
  });

  it('says nothing about a reference override whose root dependency already exists', async () => {
    const h = await workspace();
    await put(
      h,
      '/app/ws/package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        dependencies: { '@opentelemetry/api': '1.9.1' },
        overrides: { '@opentelemetry/api': '$@opentelemetry/api' },
      }),
    );
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(dependencies(h, '/app/ws/package.json')['@opentelemetry/api']).toBe('1.9.1');
    expect(h.out.join('\n')).not.toContain('left ');
  });

  it('ignores an overrides value that is not an object', async () => {
    const h = await workspace();
    await put(h, '/app/ws/package.json', JSON.stringify({ workspaces: ['apps/*'], overrides: [] }));
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    for (const peer of peers) {
      expect(dependencies(h, '/app/ws/package.json')[peer]).toBe(CLIENT_RANGES[peer]);
    }
    expect(h.out.join('\n')).not.toContain('left ');
  });

  it('places transport-selected ioredis in root dependencies too', async () => {
    const h = await workspace();
    const manifest = JSON.parse(h.read('/app/ws/setu.workspace.json')) as Record<string, unknown>;
    await put(
      h,
      '/app/ws/setu.workspace.json',
      JSON.stringify({ ...manifest, transport: 'redis' }),
    );
    expect(await h.run(['cache', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(dependencies(h, '/app/ws/package.json')['ioredis']).toBe(CLIENT_RANGES['ioredis']);
  });

  it('reports both paths in dry-run and writes nothing', async () => {
    const h = await workspace();
    const writes = h.fs.writes.length;
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api', '--dry-run'])).toBe(0);
    expect(h.fs.writes.length).toBe(writes);
    expect(h.out).toContain('would update /app/ws/package.json');
    expect(h.out).toContain('would update /app/ws/apps/api/package.json');
  });

  it('leaves a Deno workspace root unchanged, even if it carries package.json', async () => {
    const h = await workspace('deno');
    await put(h, '/app/ws/package.json', '{}');
    const before = h.read('/app/ws/deno.json');
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(h.read('/app/ws/package.json')).toBe('{}');
    expect(h.read('/app/ws/deno.json')).toBe(before);
    expect(h.read('/app/ws/apps/api/deno.json')).toContain('@opentelemetry/api');
  });

  it('does not reach an unrelated ancestor from a standalone project', async () => {
    const h = harness({ '/package.json': '{}', '/app/package.json': '{}' });
    expect(await h.run(['telemetry'])).toBe(0);
    expect(h.read('/package.json')).toBe('{}');
    expect(dependencies(h, '/app/package.json')['@opentelemetry/api']).toBe(
      CLIENT_RANGES['@opentelemetry/api'],
    );
  });

  it('keeps the member-only behavior when the root package.json is missing', async () => {
    const h = await workspace();
    await h.fs.rm('/app/ws/package.json');
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(h.fs.has('/app/ws/package.json')).toBe(false);
    expect(dependencies(h, '/app/ws/apps/api/package.json')['@opentelemetry/api']).toBe(
      CLIENT_RANGES['@opentelemetry/api'],
    );
  });

  for (const [source, refusal] of [
    ['not json', 'Cannot read /app/ws/package.json as JSON'],
    ['{ /* keep */ "workspaces": ["apps/*"], }', '/app/ws/package.json is JSONC'],
  ]) {
    it(`refuses ${refusal} before writing either manifest`, async () => {
      const h = await workspace();
      await put(h, '/app/ws/package.json', source!);
      const writes = h.fs.writes.length;
      expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(1);
      expect(h.err.join('\n')).toContain(refusal);
      expect(h.fs.writes.length).toBe(writes);
    });
  }

  it('reports an unreadable root file by name before any writes', async () => {
    const h = await workspace();
    const read = h.fs.readFile.bind(h.fs);
    h.fs.readFile = (path) =>
      path === '/app/ws/package.json' ? Promise.reject(new Error('access denied')) : read(path);
    const writes = h.fs.writes.length;
    expect(await h.run(['telemetry', '--dir', '/app/ws/apps/api'])).toBe(1);
    expect(h.err.join('\n')).toContain('Cannot read /app/ws/package.json as JSON');
    expect(h.fs.writes.length).toBe(writes);
  });
});

const DENO_MANIFEST = JSON.stringify(
  {
    tasks: { start: 'deno run main.ts' },
    imports: { '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^1' },
  },
  null,
  2,
);

/**
 * A class-based project's manifest. A real one pins `decorator-plugin` — that pin is
 * what selects the class-based generator — so a fixture pairing the class-based
 * config with the bare manifest describes a project that cannot exist.
 */
const CLASS_BASED_MANIFEST = JSON.stringify(
  {
    tasks: { start: 'deno run main.ts' },
    imports: {
      '@setu-ts/decorator-plugin': 'jsr:@setu-ts/decorator-plugin@^1',
      '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^1',
    },
  },
  null,
  2,
);

/** The class-based config with its decorator wiring removed: a functional scaffold. */
const FUNCTIONAL_CONFIG = `import { createApplication } from '@setu-ts/kernel';

export function createApp() {
  return createApplication({
    plugins: [
      ...(devtool?.plugins ?? []),
    ],
  });
}
`;

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
  for (const name of ['view', '@setu-ts/view-plugin', 'localization', 'idempotency']) {
    it(`add ${name} succeeds`, async () => {
      const h = harness({ '/app/deno.json': DENO_MANIFEST });
      expect(await h.run([name])).toBe(0);
    });
  }
  for (const name of ['diagnostics', '@setu-ts/diagnostics-plugin']) {
    it(`refuses ${name} with devtool enable guidance`, async () => {
      const h = harness({ '/app/deno.json': DENO_MANIFEST });
      expect(await h.run([name])).toBe(2);
      expect(h.err.join('\n')).toContain(
        `\`@setu-ts/diagnostics-plugin\` is installed and wired by \`deno run -A npm:@setu-ts/cli@${VERSION} devtool enable\`.`,
      );
      expect(h.fs.writes).toEqual([]);
    });
  }
  const inserted = [
    ['worker-pool', 'WorkerPoolPlugin'],
    ['secrets', 'SecretsPlugin'],
    ['storage', 'StoragePlugin'],
    ['audit', 'AuditPlugin'],
    ['mail', 'MailPlugin'],
    ['resilience', 'ResiliencePlugin'],
    ['view', 'ViewPlugin'],
    ['idempotency', 'IdempotencyPlugin'],
  ] as const;
  for (const [name, symbol] of inserted) {
    it(`inserts ${symbol} once and a second add is idempotent`, async () => {
      const h = harness({
        '/app/deno.json': DENO_MANIFEST,
        '/app/setu.config.ts': FUNCTIONAL_CONFIG,
      });
      expect(await h.run([name])).toBe(0);
      const config = h.read('/app/setu.config.ts');
      expect(config.split(`${symbol}()`).length - 1).toBe(1);
      expect(await h.run([name])).toBe(0);
      expect(h.read('/app/setu.config.ts')).toBe(config);
    });
  }
  for (const [name, line] of [
    ['telemetry', "TelemetryPlugin({ serviceName: '<service-name>', exporter: 'console' })"],
    ['localization', "LocalizationPlugin({ supportedLocales: ['en'], catalogues: { en: {} } })"],
  ]) {
    it(`prints the ${name} choice and preserves config bytes`, async () => {
      const h = harness({
        '/app/deno.json': DENO_MANIFEST,
        '/app/setu.config.ts': FUNCTIONAL_CONFIG,
      });
      expect(await h.run([name])).toBe(0);
      expect(h.out.join('\n')).toContain(line);
      expect(h.read('/app/setu.config.ts')).toBe(FUNCTIONAL_CONFIG);
      expect(await h.run([name])).toBe(0);
      expect(h.read('/app/setu.config.ts')).toBe(FUNCTIONAL_CONFIG);
    });
  }
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
    // Conditional gates are evaluated over the installed sets that reach each arm,
    // so a gate naming a package only in some compositions (`common` for
    // `migration`) is covered too.
    const sets: readonly ReadonlySet<string>[] = [
      new Set(),
      new Set(['database-plugin']),
      new Set(['decorator-plugin', 'di-plugin']),
    ];
    const gates = listSchematics()
      .flatMap(({ requiresPlugin, requiresPluginWhen }) => [
        requiresPlugin,
        ...sets.map((installed) => requiresPluginWhen?.(installed)),
      ])
      .filter((plugin): plugin is string => plugin !== undefined);

    expect(gates.length, 'no gated schematics — this check would be vacuous').toBeGreaterThan(0);
    for (const plugin of gates) {
      expect(resolveAddablePackage(plugin), plugin).toBe(plugin);
    }
  });
});

describe('setu add common', () => {
  it('pins common, the package a generated migration runner imports', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['common'])).toBe(0);
    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/common']).toBe(
      `npm:@setu-ts/common@^${VERSION}`,
    );
  });
});

describe('setu add testing', () => {
  it('pins testing in the Deno import map', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['testing'])).toBe(0);
    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/testing']).toBe(
      `npm:@setu-ts/testing@^${VERSION}`,
    );
  });

  for (const start of ['tsx main.ts', 'bun run main.ts']) {
    it(`uses devDependencies on the ${start} target`, async () => {
      const h = harness({ '/app/package.json': JSON.stringify({ scripts: { start } }) });
      expect(await h.run(['testing'])).toBe(0);
      const manifest = JSON.parse(h.read('/app/package.json'));
      expect(manifest.devDependencies['@setu-ts/testing']).toBe(`^${VERSION}`);
      expect(manifest.dependencies?.['@setu-ts/testing']).toBeUndefined();
    });
  }

  it('does not pin a package twice when the other npm section already holds it', async () => {
    // A scaffold may list a package in one section while `add` writes the
    // other; writing it again would pin it in both.
    const range = `^${VERSION}`;
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
    expect(pinnedInOtherNpmSection('{not json', 'package.json', 'dependencies', 'x', range)).toBe(
      false,
    );
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
    const source = `${JSON.stringify(
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
    )}\n`;
    const updated = withDependency(source, 'imports', '@setu-ts/cache-plugin', 'cache')!;
    const added = '    "@setu-ts/cache-plugin": "cache",\n';
    expect(updated.replace(added, '')).toBe(source);
  });

  it('updates an existing value in place', () => {
    const source = JSON.stringify({ imports: { z: 'old', a: 'a' } });
    expect(Object.keys(JSON.parse(withDependency(source, 'imports', 'z', 'new')!).imports)).toEqual(
      ['z', 'a'],
    );
  });

  it('appends an unscoped entry to an unsorted map', () => {
    const source = JSON.stringify({ imports: { z: 'z', a: 'a' } });
    expect(Object.keys(JSON.parse(withDependency(source, 'imports', 'b', 'b')!).imports)).toEqual([
      'z',
      'a',
      'b',
    ]);
  });

  it('reports no change when the entry is already present with that value', () => {
    const once = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(
      withDependency(once ?? '', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1'),
    ).toBeUndefined();
  });

  it('creates the section when the manifest has none', () => {
    const updated = withDependency('{}', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(JSON.parse(updated ?? '')).toEqual({ imports: { '@setu-ts/auth-plugin': 'jsr:x@^1' } });
  });
});

describe('withPluginWiring', () => {
  // Codex review (M111d): an npm-target scaffold is Prettier-formatted, which
  // puts a short plugin array on ONE line — so an anchor matched only as its own
  // line left `setu new demo` → `setu add cache` writing the dependency and
  // wiring nothing.
  it('wires a provider into the default (Prettier-formatted) Node scaffold', async () => {
    const fs = createFakeFs();
    const quiet = { fs, log: () => {}, error: () => {} };
    expect(await runNewCommand(parseArgs(['demo']), { ...quiet, cwd: '/' })).toBe(0);
    const before = fs.read('/demo/setu.config.ts');
    expect(before).toMatch(/plugins: \[[^\n]*\.\.\.\(devtool\?\.plugins \?\? \[\]\)\]/);

    expect(await runAddCommand(parseArgs(['cache']), { ...quiet, cwd: '/demo' })).toBe(0);
    const after = fs.read('/demo/setu.config.ts');
    expect(after).toContain("import { CachePlugin } from '@setu-ts/cache-plugin';");
    expect(after).toContain('CachePlugin(), ...(devtool?.plugins ?? [])');
  });

  it('refuses a factory carrying the spread twice', () => {
    const doubled = CLASS_BASED_INGRESS_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      '...(devtool?.plugins ?? []),\n      ...(devtool?.plugins ?? []),',
    );
    expect(doubled).not.toBe(CLASS_BASED_INGRESS_CONFIG);
    expect(withPluginWiring(doubled, 'cache-plugin')).toBeUndefined();
  });

  it('preserves inline, commented and incomplete anchors, and ignores commented calls', () => {
    for (const source of [
      'const plugins = [...(devtool?.plugins ?? []),];',
      '// ...(devtool?.plugins ?? []),',
      '/*\n...(devtool?.plugins ?? []),\n*/',
      "'unterminated\n...(devtool?.plugins ?? []),",
    ])
      expect(withPluginWiring(source, 'cache-plugin')).toBeUndefined();
    const source =
      '// CachePlugin()\n// ...(devtool?.plugins ?? []),\n' + CLASS_BASED_INGRESS_CONFIG;
    const result = withPluginWiring(source, 'cache-plugin')!;
    expect(result).toContain('// ...(devtool?.plugins ?? []),\n');
    expect(result).toContain('      CachePlugin(),\n      ...(devtool?.plugins ?? []),');
  });
  // Audit L1: a plugin built once at module scope and listed by name is already
  // registered. Checking only the factory body inserted a second call, and the kernel
  // then refused the duplicate plugin name at boot.
  it('does not wire a provider the file already constructs outside the factory', () => {
    const source =
      "import { CachePlugin } from '@setu-ts/cache-plugin';\n" +
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
    for (const [prefix, item] of [
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
    ] as const)
      expect(withPluginWiring(listed(prefix, item), 'cache-plugin'), prefix).toBeUndefined();
    // Its own import is not a use, and a commented call is not one either.
    expect(withPluginWiring(listed(imported, ''), 'cache-plugin')).toContain('CachePlugin(),');
    expect(withPluginWiring(listed(imported, '// CachePlugin(),'), 'cache-plugin')).toContain(
      '      CachePlugin(),\n      ...(devtool?.plugins ?? []),',
    );
  });

  // Audit round 4 (G-R4): refusing the insert on a possible use must not also
  // silence the guidance, or the plugin is left unregistered with nothing said.
  it('still prints registration guidance when only a string mentions the factory', async () => {
    const config =
      "import { CachePlugin } from '@setu-ts/cache-plugin';\n" +
      "export const note = 'see CachePlugin docs';\n" +
      CLASS_BASED_INGRESS_CONFIG;
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
    for (const config of [
      imported + "export const note = 'CachePlugin()';\n" + CLASS_BASED_INGRESS_CONFIG,
      '#! CachePlugin()\n' + imported + CLASS_BASED_INGRESS_CONFIG,
      imported + 'const éCachePlugin = () => CachePlugin;\n' + CLASS_BASED_INGRESS_CONFIG,
    ]) {
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
  for (const [bare, symbol] of [
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
  ] as const) {
    it(`activates ${bare} in the generated class-based ingress config`, () => {
      const updated = withPluginWiring(CLASS_BASED_INGRESS_CONFIG, bare);

      expect(updated).toContain(`import { ${symbol} } from '@setu-ts/${bare}';`);
      expect(updated).toContain(`      ${symbol}(),`);
    });
  }

  it('does not rewrite a custom decorator config or a provider it already constructs', () => {
    const custom = CLASS_BASED_INGRESS_CONFIG.replace('...(devtool?.plugins ?? []),', '');
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
    const source = `import * as events from '@setu-ts/events-plugin';\n${CLASS_BASED_INGRESS_CONFIG}`;
    expect(withPluginWiring(source, 'events-plugin')).toBeUndefined();
  });

  it('reuses a provider import that exists before its plugin construction is added', () => {
    const source = CLASS_BASED_INGRESS_CONFIG.replace(
      "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
      "import { EventsPlugin } from '@setu-ts/events-plugin';\n" +
        "import { INGRESS_HANDLERS } from './src/ingress/index.ts';",
    );
    const updated = withPluginWiring(source, 'events-plugin') ?? '';

    expect(
      updated.match(/import \{ EventsPlugin \} from '@setu-ts\/events-plugin';/g),
    ).toHaveLength(1);
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
      const options = await nodeFs.readFile(
        new URL(`../../../../starters/${tier}-starter/src/options.ts`, import.meta.url),
        'utf8',
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
        if (['messaging', 'queue'].includes(arm)) {
          expect(h.out.join('\n'), bare).toContain('in memory by default');
        } else {
          expect(h.out.join('\n'), bare).toContain(`configure its ${arm} arm`);
        }
        // Scoped: a gated arm registers nothing until configured, so an
        // unconditional "would fail" was false for it.
        if (!['messaging', 'queue'].includes(arm))
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
    for (const [pkg, symbol] of [
      ['rest-starter', 'createRestApp'],
      ['microservice-starter', 'createMicroserviceApp'],
      ['full-stack-starter', 'createFullStackAppFromConfig'],
    ]) {
      const config = `import { ${symbol} } from '@setu-ts/${pkg}';\nexport async function createApp() {}\n`;
      const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });
      expect(await h.run(['auth'])).toBe(0);
      expect(h.out.join('\n')).toContain('configure its auth arm');
      expect(h.out.join('\n')).toContain(
        `https://github.com/setu-ts/setu-ts/blob/v${VERSION}/packages/starters/${pkg}/README.md`,
      );
      expect(h.out.join('\n')).not.toContain('/blob/develop/');
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
    for (const [pkg, factory] of [
      ['database', 'DatabasePlugin'],
      ['feature-flags', 'FeatureFlagsPlugin'],
      ['notification', 'NotificationPlugin'],
      ['graphql', 'GraphqlPlugin'],
      ['static', 'StaticPlugin'],
      ['multi-tenancy', 'MultiTenancyPlugin'],
      ['service-discovery', 'ServiceDiscoveryPlugin'],
    ]) {
      const h = harness({ '/app/deno.json': DENO_MANIFEST });
      expect(await h.run([pkg!]), h.err.join('\n')).toBe(0);
      expect(h.out.join('\n')).toContain(`Register ${factory}({`);
    }
    const worker = harness({ '/app/deno.json': DENO_MANIFEST, '/app/wrangler.jsonc': '{}' });
    expect(await worker.run(['cloudflare']), worker.err.join('\n')).toBe(0);
    expect(worker.out.join('\n')).toContain(
      'Register CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })',
    );
    // The printed line reads `waitUntil`, while a 0.10.0 factory names the
    // unread parameter `_waitUntil` and an older one has none (M113d §3.8):
    // both steps are printed, and the file itself is never classified.
    expect(worker.out.join('\n')).toContain("rename the '_waitUntil' parameter to 'waitUntil'");
    expect(worker.out.join('\n')).toContain('docs/upgrading.md');
  });

  it('prints only registrations that type-check against their plugin option types', async () => {
    // The fixture is reached by `deno check packages`, so each line it carries
    // compiles against the real option type; this test pins that every printed
    // line IS one of them, verbatim.
    const fixture = await nodeFs.readFile(
      new URL('../../fixtures/registration-lines.ts', import.meta.url),
      'utf8',
    );
    const printed: string[] = [];
    for (const pkg of [
      'auth',
      'session',
      'grpc',
      'database',
      'feature-flags',
      'notification',
      'graphql',
      'static',
      'multi-tenancy',
      'service-discovery',
      'cloudflare',
    ]) {
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
    const starter =
      "import { buildRestPlugins } from '@setu-ts/rest-starter';\n" +
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
    for (const extra of [
      'const docs = { CachePlugin() { return 1; } };\n',
      'class Docs { CachePlugin() { return 1; } }\n',
      'interface Docs { CachePlugin(): string }\n',
      'function helper() { return CachePlugin(); }\n',
    ]) {
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
  // PR #415 review: a manual line reads `sources.<key>`, so guidance for a
  // configuration the CLI declined to edit must name the binding it reads.
  it('prints the sources import and declaration beside a manual line', async () => {
    const config = CLASS_BASED_INGRESS_CONFIG + 'const banner = `unclassified`;\n';
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': config,
      '/app/src/devtool/diagnostics.ts': 'old managed module',
    });
    expect(await h.run(['cache'])).toBe(0);
    expect(h.read('/app/setu.config.ts')).toBe(config);
    const out = h.out.join('\n');
    expect(out).toContain(
      "In setu.config.ts: Add the import: import { DEVTOOL_SOURCES } from './src/devtool/diagnostics.ts';",
    );
    expect(out).toContain('devtool === undefined ? {} : DEVTOOL_SOURCES;');
    expect(out.indexOf('Add the import')).toBeLessThan(
      out.indexOf('Configure the development source'),
    );
  });

  it('refuses with exit 1 and writes nothing when a runtime marker is unreadable', async () => {
    const fs = createFakeFs({ '/app/deno.json': DENO_MANIFEST, '/app/wrangler.jsonc': '{}' });
    const err: string[] = [];
    const code = await runAddCommand(parseArgs(['cloudflare-plugin']), {
      fs: {
        ...fs,
        stat: (path: string) =>
          path === '/app/wrangler.jsonc'
            ? Promise.reject(new Error('EACCES: permission denied'))
            : fs.stat(path),
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
    expect(parsed.imports['@setu-ts/auth-plugin']).toBe(`npm:@setu-ts/auth-plugin@^${VERSION}`);
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
    expect(JSON.parse(h.read('/app/package.json')).dependencies['@setu-ts/auth-plugin']).toBe(
      `^${VERSION}`,
    );
  });

  it('activates an ingress provider in the generated class-based config', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED_MANIFEST,
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
      '/app/deno.json': CLASS_BASED_MANIFEST,
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
    expect(
      JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'],
    ).toBeDefined();
  });

  it('accepts --dir=<path> as well as --dir <path>', async () => {
    const h = harness({ '/app/services/orders/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', '--dir=services/orders'])).toBe(0);
    expect(
      JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'],
    ).toBeDefined();
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

  it('should tell a Deno health installer that the self check needs --allow-sys', async () => {
    // Measured on a bare Deno scaffold: without the flag the built-in `self`
    // indicator fails and `/health` (so `/ready`) reports down.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['health'])).toBe(0);

    expect(h.out.join('\n')).toContain('--allow-sys');
  });

  it('should print no Deno permission note on a Node project', async () => {
    const h = harness({
      '/app/package.json': JSON.stringify({ name: 'app', dependencies: {} }, null, 2),
    });

    expect(await h.run(['health'])).toBe(0);
    expect(await h.run(['storage'])).toBe(0);

    const output = h.out.join('\n');
    expect(output).not.toContain('--allow-sys');
    expect(output).not.toContain('--allow-write');
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

  // From 0.9 the framework installs from npm under its own names, so an npm
  // project needs no registry mapping and is never told to add one.
  it('says nothing about .npmrc for an npm project with none', async () => {
    const h = harness({ '/app/package.json': pkg('tsx main.ts') });
    expect(await h.run(['cache'])).toBe(0);
    expect(h.out.join('\n')).not.toContain('.npmrc');
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

  for (const [label, files, marker] of [
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
  ] as const) {
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

describe('setu add wires the generated-artifact seam', () => {
  it('passes generated event handlers to EventsPlugin and creates the empty barrel', async () => {
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': FUNCTIONAL_CONFIG,
    });

    expect(await h.run(['events'])).toBe(0);

    const config = h.read('/app/setu.config.ts');
    expect(config).toContain(`import { EVENT_HANDLERS } from './src/events/index.ts';`);
    expect(config).toContain('      EventsPlugin({ handlers: EVENT_HANDLERS }),');
    expect(h.read('/app/src/events/index.ts')).toBe(EVENTS_SEAM.renderBarrel({}));
    expect(h.out.join('\n')).not.toContain('Register EventsPlugin');
  });

  it('passes both CQRS handler lists to CqrsPlugin from one barrel import', async () => {
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': FUNCTIONAL_CONFIG,
    });

    expect(await h.run(['cqrs'])).toBe(0);

    const config = h.read('/app/setu.config.ts');
    expect(config).toContain(
      `import { COMMAND_HANDLERS, QUERY_HANDLERS } from './src/cqrs/index.ts';`,
    );
    expect(config).toContain(
      'CqrsPlugin({ commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS }),',
    );
    expect(config.split("'./src/cqrs/index.ts'")).toHaveLength(2);
    expect(h.read('/app/src/cqrs/index.ts')).toBe(COMMAND_HANDLER_SEAM.renderBarrel({}));
  });

  it('keeps the bare call and writes no barrel in a class-based project', async () => {
    const h = harness({
      '/app/deno.json': CLASS_BASED_MANIFEST,
      '/app/setu.config.ts': CLASS_BASED_INGRESS_CONFIG,
    });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toContain('      EventsPlugin(),');
    expect(() => h.read('/app/src/events/index.ts')).toThrow();
  });

  it('leaves an existing barrel alone', async () => {
    const existing = '// hand-kept\nexport const EVENT_HANDLERS = [];\n';
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/setu.config.ts': FUNCTIONAL_CONFIG,
      '/app/src/events/index.ts': existing,
    });

    expect(await h.run(['events'])).toBe(0);
    expect(h.read('/app/src/events/index.ts')).toBe(existing);
  });

  it('falls back to guidance naming the seam when the barrel is already referenced', async () => {
    const config = `import { EVENT_HANDLERS } from './src/events/index.ts';\n${FUNCTIONAL_CONFIG}`;
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': config });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toBe(config);
    const out = h.out.join('\n');
    expect(out).toContain('Register EventsPlugin({ handlers: EVENT_HANDLERS }) in setu.config.ts.');
    expect(out).toContain("Import EVENT_HANDLERS from './src/events/index.ts' for it.");
  });

  it('writes no barrel when the package is already installed', async () => {
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const h = harness({ '/app/deno.json': installed });

    expect(await h.run(['events'])).toBe(0);
    expect(h.out.join('\n')).toContain('already installed');
    expect(() => h.read('/app/src/events/index.ts')).toThrow();
  });

  it('creates the barrel it wires when re-adding an installed package', async () => {
    // The manifest already pins the package, so no manifest edit happens — but
    // the config has no provider call, so it IS wired. The import it gains must
    // resolve: the barrel is created whenever the config is edited to read it.
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const h = harness({ '/app/deno.json': installed, '/app/setu.config.ts': FUNCTIONAL_CONFIG });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toContain(`from './src/events/index.ts'`);
    expect(h.read('/app/src/events/index.ts')).toBe(EVENTS_SEAM.renderBarrel({}));
  });

  it('names the missing seam when an installed provider is called bare', async () => {
    // The state of a project that ran `setu add events` before it wired the seam.
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const bare = `import { EventsPlugin } from '@setu-ts/events-plugin';\n${FUNCTIONAL_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      'EventsPlugin(),\n      ...(devtool?.plugins ?? []),',
    )}`;
    const h = harness({ '/app/deno.json': installed, '/app/setu.config.ts': bare });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toBe(bare);
    const out = h.out.join('\n');
    expect(out).toContain('already installed');
    expect(out).toContain(
      'The existing EventsPlugin(…) call does not pass the generated artifacts; give it { handlers: EVENT_HANDLERS }.',
    );
    expect(out).toContain("Import EVENT_HANDLERS from './src/events/index.ts' for it.");
  });

  it('says nothing more when the existing call already passes the seam', async () => {
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const wired = `import { EventsPlugin } from '@setu-ts/events-plugin';\nimport { EVENT_HANDLERS } from './src/events/index.ts';\n${FUNCTIONAL_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      'EventsPlugin({ handlers: EVENT_HANDLERS }),\n      ...(devtool?.plugins ?? []),',
    )}`;
    const h = harness({ '/app/deno.json': installed, '/app/setu.config.ts': wired });

    expect(await h.run(['events'])).toBe(0);
    expect(h.out.join('\n')).not.toContain('does not pass the generated artifacts');
  });

  it('names the missing seam on a fresh install whose config already calls the provider bare', async () => {
    const bare = `import { EventsPlugin } from '@setu-ts/events-plugin';\n${FUNCTIONAL_CONFIG.replace(
      '...(devtool?.plugins ?? []),',
      'EventsPlugin(),\n      ...(devtool?.plugins ?? []),',
    )}`;
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': bare });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toBe(bare);
    expect(h.out.join('\n')).toContain('give it { handlers: EVENT_HANDLERS }');
  });

  it('names the missing seam when the factory reads the barrel but calls the provider bare', async () => {
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const config = `import { EventsPlugin } from '@setu-ts/events-plugin';\nimport { EVENT_HANDLERS } from './src/events/index.ts';\n${FUNCTIONAL_CONFIG.replace(
      'return createApplication({',
      'void EVENT_HANDLERS.length;\n  return createApplication({',
    ).replace(
      '...(devtool?.plugins ?? []),',
      'EventsPlugin(),\n      ...(devtool?.plugins ?? []),',
    )}`;
    const h = harness({ '/app/deno.json': installed, '/app/setu.config.ts': config });

    expect(await h.run(['events'])).toBe(0);

    const out = h.out.join('\n');
    expect(out).toContain('give it { handlers: EVENT_HANDLERS }');
    expect(out).not.toContain('Import EVENT_HANDLERS');
  });

  it('names the missing seam under a starter that does not own the plugin', async () => {
    const installed = JSON.stringify({
      imports: { '@setu-ts/events-plugin': `npm:@setu-ts/events-plugin@^${VERSION}` },
    });
    const config = `import { createRestApp } from '@setu-ts/rest-starter';
import { EventsPlugin } from '@setu-ts/events-plugin';

export function createApp() {
  const app = createRestApp({});
  app.register(EventsPlugin());
  return app;
}
`;
    const h = harness({ '/app/deno.json': installed, '/app/setu.config.ts': config });

    expect(await h.run(['events'])).toBe(0);

    expect(h.out.join('\n')).toContain('give it { handlers: EVENT_HANDLERS }');
  });

  it('resolves no seam for a provider that consumes none', () => {
    expect(addSeam('queue-plugin', new Set(['queue-plugin']))?.args).toContain('QUEUE_PROCESSORS');
    expect(addSeam('auth-plugin', new Set(['auth-plugin']))).toBeUndefined();
  });

  it('names the seam for a starter-owned arm, so generated handlers reach it', async () => {
    const starter = `import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';

export async function createApp() {
  return await createFullStackAppFromConfig(() => ({}));
}
`;
    const h = harness({ '/app/deno.json': DENO_MANIFEST, '/app/setu.config.ts': starter });

    expect(await h.run(['events'])).toBe(0);

    expect(h.read('/app/setu.config.ts')).toBe(starter);
    const out = h.out.join('\n');
    expect(out).toContain('configure its events arm');
    expect(out).toContain(
      'Pass the generated artifacts through it: events: { handlers: EVENT_HANDLERS }',
    );
    expect(out).toContain("Import EVENT_HANDLERS from './src/events/index.ts' for it.");
    expect(h.read('/app/src/events/index.ts')).toBe(EVENTS_SEAM.renderBarrel({}));
  });
});

describe('setu add validation — Zod dependency', () => {
  for (const target of ['node', 'deno', 'bun', 'cloudflare-workers'] as const) {
    it(`declares zod on ${target}`, async () => {
      const deno = target === 'deno' || target === 'cloudflare-workers';
      const h = harness(
        deno
          ? {
              '/app/deno.json': DENO_MANIFEST,
              ...(target === 'cloudflare-workers'
                ? { '/app/wrangler.toml': 'name = "edge"\n' }
                : {}),
            }
          : {
              '/app/package.json': JSON.stringify({
                name: 'svc',
                scripts: { start: target === 'bun' ? 'bun run main.ts' : 'tsx main.ts' },
                dependencies: {},
              }),
            },
      );
      expect(await h.run(['validation'])).toBe(0);
      const updated = JSON.parse(h.read(deno ? '/app/deno.json' : '/app/package.json')) as {
        imports?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      expect(deno ? updated.imports?.['zod'] : updated.dependencies?.['zod']).toBe(
        deno ? 'npm:zod@^4.6.6' : '^4.6.6',
      );
    });
  }
});

describe('setu add — the Node ws peer (M113h §3.8a)', () => {
  /** A Node project manifest, as `detectTargetRuntime` recognizes one. */
  function nodeManifest(dependencies: Readonly<Record<string, string>> = {}): string {
    return JSON.stringify(
      { name: 'svc', scripts: { start: 'tsx main.ts' }, dependencies },
      null,
      2,
    );
  }

  it('adds ws at its peer range on Node and names it', async () => {
    const h = harness({ '/app/package.json': nodeManifest() });

    expect(await h.run(['websocket'])).toBe(0);

    const dependencies = JSON.parse(h.read('/app/package.json')).dependencies as Record<
      string,
      string
    >;
    expect(dependencies['@setu-ts/websocket-plugin']).toBe(`^${VERSION}`);
    expect(dependencies['ws']).toBe('^8.18.0');
    expect(h.out.join('\n')).toContain(
      'added ws (the Node WebSocket server, an optional peer of @setu-ts/runtime)',
    );
  });

  it('adds ws when the plugin is already pinned — the recovery path', async () => {
    // A project scaffolded before the peer arm carries the plugin but not `ws`,
    // and its first upgrade answers 500. Re-running the command must repair it.
    const h = harness({
      '/app/package.json': nodeManifest({ '@setu-ts/websocket-plugin': `^${VERSION}` }),
    });

    expect(await h.run(['websocket'])).toBe(0);

    expect(JSON.parse(h.read('/app/package.json')).dependencies['ws']).toBe('^8.18.0');
    expect(h.out.join('\n')).toContain('added ws (the Node WebSocket server');
  });

  it('never overwrites an existing ws pin', async () => {
    const h = harness({ '/app/package.json': nodeManifest({ ws: '^7.0.0' }) });

    expect(await h.run(['websocket'])).toBe(0);

    expect(JSON.parse(h.read('/app/package.json')).dependencies['ws']).toBe('^7.0.0');
    expect(h.out.join('\n')).not.toContain('added ws');
  });

  for (const [runtime, manifest, extra] of [
    [
      'Bun',
      JSON.stringify(
        { name: 'svc', scripts: { start: 'bun run main.ts' }, dependencies: {} },
        null,
        2,
      ),
      {},
    ],
    [
      'Workers',
      JSON.stringify(
        { name: 'svc', scripts: { start: 'wrangler dev' }, dependencies: {} },
        null,
        2,
      ),
      { '/app/wrangler.toml': 'name = "edge"\n', '/app/deno.json': DENO_MANIFEST },
    ],
  ] as const) {
    it(`adds no peer on ${runtime}`, async () => {
      const h = harness({ '/app/package.json': manifest, ...extra });

      expect(await h.run(['websocket'])).toBe(0);

      expect(JSON.parse(h.read('/app/package.json')).dependencies['ws']).toBeUndefined();
      expect(h.out.join('\n')).not.toContain('added ws');
    });
  }

  it('adds no peer for a package that declares none', async () => {
    const h = harness({ '/app/package.json': nodeManifest() });

    expect(await h.run(['auth'])).toBe(0);

    expect(JSON.parse(h.read('/app/package.json')).dependencies['ws']).toBeUndefined();
  });
});

describe('setu add view styling (M123)', () => {
  for (const runtime of ['node', 'bun', 'deno', 'cloudflare-workers']) {
    it(`writes the view plan and hono peer on ${runtime}, then is idempotent`, async () => {
      const h = harness();
      expect(
        await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', runtime]), {
          fs: h.fs,
          cwd: '/app',
          log: (line) => h.out.push(line),
          error: (line) => h.err.push(line),
        }),
      ).toBe(0);
      expect(await h.run(['view', '--dir', '/app/shop'])).toBe(0);
      const path = runtime === 'deno' ? 'deno.json' : 'package.json';
      const manifest = JSON.parse(h.read(`/app/shop/${path}`));
      expect(manifest[runtime === 'deno' ? 'imports' : 'dependencies'].hono).toBe(
        runtime === 'deno' ? 'npm:hono@^4.12.30' : '^4.12.30',
      );
      expect(h.read('/app/shop/src/views/routes.ts')).toContain("router.get('/ui'");
      expect(h.read('/app/shop/src/views/home.tsx')).toContain('bg-primary');
      const before = h.read(`/app/shop/${path}`);
      h.out.length = 0;
      expect(await h.run(['view', '--dir', '/app/shop'])).toBe(0);
      expect(h.read(`/app/shop/${path}`)).toBe(before);
      expect(h.out.some((line) => /^(created|updated) /.test(line))).toBe(false);
    });
  }
  it('wires the example route when ViewPlugin was registered by an earlier add', async () => {
    const h = harness();
    expect(
      await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', 'node']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: (line) => h.err.push(line),
      }),
    ).toBe(0);
    expect(await h.run(['view', '--dir', '/app/shop'])).toBe(0);
    // The 0.10.0 shape: ViewPlugin() registered, no example route and no views.
    const config = h
      .read('/app/shop/setu.config.ts')
      .replace("import { registerViewRoutes } from './src/views/routes.ts';\n", '')
      .replace(/\n\s*registerViewRoutes\(app\.router\);/, '');
    expect(config).toContain('ViewPlugin()');
    expect(config).not.toContain('registerViewRoutes');
    await h.fs.writeFile('/app/shop/setu.config.ts', new TextEncoder().encode(config));
    for (const file of ['layout.tsx', 'home.tsx', 'routes.ts', 'styles.css'])
      await h.fs.rm(`/app/shop/src/views/${file}`);

    expect(await h.run(['view', '--dir', '/app/shop'])).toBe(0);
    const rewired = h.read('/app/shop/setu.config.ts');
    expect(rewired).toContain("import { registerViewRoutes } from './src/views/routes.ts';");
    expect(rewired).toMatch(
      /registerGeneratedRoutes\(app\.router, app\.services\);\n\s*registerViewRoutes\(app\.router\);/,
    );
    expect(rewired.match(/ViewPlugin\(\)/g)).toHaveLength(1);
    expect(h.read('/app/shop/src/views/routes.ts')).toContain("router.get('/ui'");
  });
  it('refuses an unreadable view file by name, before writing anything', async () => {
    const h = harness();
    expect(
      await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', 'node']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: (line) => h.err.push(line),
      }),
    ).toBe(0);
    const before = h.read('/app/shop/package.json');
    await h.fs.writeFile('/app/shop/src/views/home.tsx', new TextEncoder().encode('linked'));
    const readFile = h.fs.readFile.bind(h.fs);
    // What the Node filesystem reports for a symbolic link (O_NOFOLLOW).
    h.fs.readFile = (path: string) =>
      path === '/app/shop/src/views/home.tsx'
        ? Promise.reject(new Error(`${path}: is a symbolic link; Setu does not read through links`))
        : readFile(path);
    h.err.length = 0;
    expect(await h.run(['view', '--dir', '/app/shop'])).toBe(1);
    expect(h.err).toEqual([
      'Failed to read the project for the view setup: /app/shop/src/views/home.tsx: is a symbolic link; Setu does not read through links',
    ]);
    expect(h.read('/app/shop/package.json')).toBe(before);
    expect(h.fs.has('/app/shop/src/views/layout.tsx')).toBe(false);
  });
  it('lists every planned file in a dry-run and writes nothing', async () => {
    const h = harness();
    expect(
      await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', 'node']), {
        fs: h.fs,
        cwd: '/app',
        log: () => {},
        error: (line) => h.err.push(line),
      }),
    ).toBe(0);
    const before = h.read('/app/shop/package.json');
    expect(await h.run(['view', '--dir', '/app/shop', '--dry-run'])).toBe(0);
    for (const path of [
      'src/views/layout.tsx',
      'src/views/home.tsx',
      'src/views/routes.ts',
      'src/views/styles.css',
      'tsconfig.json',
      'setu.config.ts',
      'package.json',
    ]) {
      expect(h.out).toContain(`would update /app/shop/${path}`);
    }
    expect(h.read('/app/shop/package.json')).toBe(before);
    expect(h.fs.has('/app/shop/src/views/home.tsx')).toBe(false);
  });
  it('uses the existing peer override path for hono in a workspace', async () => {
    const h = harness();
    const cli = (args: string[]) =>
      runCli(args, {
        fs: h.fs,
        cwd: '/app',
        now: () => 0,
        log: () => {},
        error: (line) => h.err.push(line),
      });
    expect(await cli(['new', 'ws', '--workspace', '--runtime', 'node'])).toBe(0);
    expect(await cli(['g', 'app', 'api', '--dir', '/app/ws'])).toBe(0);
    const path = '/app/ws/package.json';
    const root = JSON.parse(h.read(path));
    root.overrides = { hono: '4.12.30' };
    await h.fs.writeFile(path, new TextEncoder().encode(JSON.stringify(root)));
    expect(await h.run(['view', '--dir', '/app/ws/apps/api'])).toBe(0);
    expect(JSON.parse(h.read(path)).dependencies.hono).toBe('4.12.30');
  });
  it('uses explicit StaticPlugin args while keeping add static manifest-only', () => {
    const config = `export function createApp(): IKernelApplication {\n  const app = createApplication({ plugins: [...(devtool?.plugins ?? [])] });\n  return app;\n}`;
    expect(withPluginWiring(config, 'static-plugin')).toBeUndefined();
    expect(
      withPluginWiring(
        config,
        'static-plugin',
        undefined,
        "{ root: './build/assets', urlPrefix: '/assets' }",
      ),
    ).toContain("StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })");
    const seam = { args: '{ old: true }', imports: [], files: [] };
    expect(withPluginWiring(config, 'view-plugin', seam, '{ explicit: true }')).toContain(
      'ViewPlugin({ explicit: true })',
    );
  });
  it('pins hono to the framework dependency table', async () => {
    const { EXTERNAL_RANGES } = await import('../../../../../scripts/node-dependency-ranges.ts');
    expect(CLIENT_RANGES['hono']).toBe(EXTERNAL_RANGES['hono']);
  });
});

it('does not wire either view provider through a retargeted framework import map', async () => {
  const h = harness();
  expect(
    await runNewCommand(parseArgs(['shop', '--template', 'rest', '--runtime', 'node']), {
      fs: h.fs,
      cwd: '/app',
      log: () => {},
      error: () => {},
    }),
  ).toBe(0);
  const config = h.read('/app/shop/setu.config.ts');
  await h.fs.writeFile(
    '/app/shop/deno.json',
    new TextEncoder().encode(
      JSON.stringify({ imports: { '@setu-ts/view-plugin': './custom-view.ts' } }),
    ),
  );
  expect(await h.run(['view', '--dir', '/app/shop'])).toBe(0);
  expect(h.read('/app/shop/setu.config.ts')).toBe(config);
});

it('preserves a view file created between planning and the writer preflight', async () => {
  const h = harness({ '/app/package.json': '{}' });
  const path = '/app/src/views/home.tsx';
  let raced = false;
  const fs = {
    ...h.fs,
    async stat(file: string) {
      if (file === path && !raced) {
        raced = true;
        try {
          return await h.fs.stat(file);
        } catch (error) {
          await h.fs.writeFile(path, new TextEncoder().encode('created by the developer'));
          throw error;
        }
      }
      return h.fs.stat(file);
    },
  };
  expect(
    await runAddCommand(parseArgs(['view']), {
      fs,
      cwd: '/app',
      log: (line) => h.out.push(line),
      error: (line) => h.err.push(line),
    }),
  ).toBe(0);
  expect(raced).toBe(true);
  expect(h.read(path)).toBe('created by the developer');
});

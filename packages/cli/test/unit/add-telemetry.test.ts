/**
 * `setu add telemetry` installs what a trace needs (M131a X88-10): the OTLP
 * exporter on every socket runtime and, on Node, the loader hook the generated
 * preload registers plus the instrumentation for the project's Redis client,
 * with the option that enables it named in the guidance.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { CLIENT_RANGES, TELEMETRY_PEERS } from '../../src/templates/client-dependencies.ts';
import { ADDABLE, withDependency } from '../../src/commands/add.ts';
import { planWorkspacePeers, withPeerDependencies } from '../../src/utils/peer-dependencies.ts';

const COMMON_PEERS = Object.fromEntries(
  [
    '@opentelemetry/api',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/resources',
    '@opentelemetry/context-async-hooks',
  ].map((name) => [name, CLIENT_RANGES[name]!]),
);

it.each([
  '[]',
  '{"dependencies":["user-owned"]}',
  '{"dependencies":{"user-owned":7}}',
  '{"devDependencies":["user-owned"]}',
])(
  'V13-36 refuses malformed peer manifests without normalizing their structure: %s',
  async (source) => {
    const h = harness();
    expect(await h.run(['new', 'ws', '--workspace'])).toBe(0);
    await h.fs.writeFile('/work/ws/package.json', new TextEncoder().encode(source));
    const peers = [{ name: '@opentelemetry/resources', range: '^2.9.0' }];
    expect(() =>
      withDependency(source, 'dependencies', '@setu-ts/telemetry-plugin', '^0.13.0'),
    ).toThrow();
    expect(() => withPeerDependencies(source, peers, 'dependencies')).toThrow();
    await expect(planWorkspacePeers(h.fs, '/work/ws', peers, () => {})).rejects.toThrow();
    expect(
      await h.run(['g', 'app', 'api', '--template', 'microservice', '--dir', '/work/ws']),
    ).toBe(1);
    expect(h.fs.read('/work/ws/package.json')).toBe(source);
    expect(h.fs.has('/work/ws/apps/api/package.json')).toBe(false);
  },
);

it('V13-36 shares the telemetry peer table between add and both microservice styles', () => {
  expect(TELEMETRY_PEERS).toEqual(COMMON_PEERS);
  expect(ADDABLE.get('telemetry')?.peers?.packages).toEqual(Object.keys(COMMON_PEERS));
});

it.each(['node', 'bun', 'deno', 'cloudflare-workers'] as const)(
  'V13-36 records microservice peers on both %s styles and add telemetry',
  async (runtime) => {
    for (const style of ['functional', 'class-based']) {
      const h = harness();
      expect(
        await h.run([
          'new',
          'svc',
          '--template',
          'microservice',
          '--runtime',
          runtime,
          '--style',
          style,
        ]),
        h.errors.join('\n'),
      ).toBe(0);
      const manifest = JSON.parse(
        h.fs.read(`/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`),
      );
      const pins = runtime === 'deno' ? manifest.imports : manifest.dependencies;
      for (const [name, range] of Object.entries(COMMON_PEERS))
        expect(pins[name], `${style}: ${name}`).toBe(
          runtime === 'deno' ? `npm:${name}@${range}` : range,
        );
    }
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'rest', '--runtime', runtime])).toBe(0);
    expect(await h.run(['add', 'telemetry', '--dir', '/work/svc']), h.errors.join('\n')).toBe(0);
    const manifest = JSON.parse(
      h.fs.read(`/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`),
    );
    const pins = runtime === 'deno' ? manifest.imports : manifest.dependencies;
    for (const [name, range] of Object.entries(COMMON_PEERS))
      expect(pins[name], name).toBe(runtime === 'deno' ? `npm:${name}@${range}` : range);
  },
);

it.each([
  ['node', 'rest'],
  ['node', 'full-stack'],
  ['bun', 'rest'],
  ['bun', 'full-stack'],
])(
  'V13-36 leaves the %s workspace root byte-identical for a %s member',
  async (runtime, template) => {
    const h = harness();
    expect(await h.run(['new', 'ws', '--workspace', '--runtime', runtime])).toBe(0);
    const before = h.fs.read('/work/ws/package.json');
    expect(
      await h.run(['g', 'app', 'api', '--template', template, '--dir', '/work/ws']),
      h.errors.join('\n'),
    ).toBe(0);
    expect(h.fs.read('/work/ws/apps/api/package.json')).toContain('dependencies');
    expect(h.fs.read('/work/ws/package.json'), template).toBe(before);
  },
);

it.each(['node', 'bun'])(
  'V13-36 records generated microservice peers in the %s workspace root',
  async (runtime) => {
    for (const style of ['functional', 'class-based']) {
      const h = harness();
      expect(await h.run(['new', 'ws', '--workspace', '--runtime', runtime])).toBe(0);
      expect(
        await h.run([
          'g',
          'app',
          'api',
          '--template',
          'microservice',
          '--style',
          style,
          '--dir',
          '/work/ws',
        ]),
        h.errors.join('\n'),
      ).toBe(0);
      for (const file of ['/work/ws/package.json', '/work/ws/apps/api/package.json']) {
        const pins = JSON.parse(h.fs.read(file)).dependencies;
        for (const [name, range] of Object.entries(COMMON_PEERS))
          expect(pins?.[name], file + ': ' + name).toBe(range);
      }
    }
  },
);

it.each(['node', 'bun', 'deno'] as const)(
  'V13-142 restores only missing Bigtable telemetry peers on %s',
  async (runtime) => {
    for (const count of [0, 2, 4]) {
      const h = harness();
      expect(await h.run(['new', 'svc', '--template', 'rest', '--runtime', runtime])).toBe(0);
      const path = `/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`;
      const source = JSON.parse(h.fs.read(path));
      const pins: Record<string, string> = source[runtime === 'deno' ? 'imports' : 'dependencies'];
      pins['@setu-ts/telemetry-plugin'] =
        runtime === 'deno' ? 'npm:@setu-ts/telemetry-plugin@^0.13.0' : '^0.13.0';
      for (const [name, range] of Object.entries(COMMON_PEERS).slice(0, count))
        pins[name] = runtime === 'deno' ? `npm:${name}@${range}` : range;
      await h.fs.writeFile(path, new TextEncoder().encode(JSON.stringify(source)));
      expect(
        await h.run(['add', 'database', '--type', 'bigtable', '--dir', '/work/svc']),
        h.errors.join('\n'),
      ).toBe(0);
      const actual = JSON.parse(h.fs.read(path))[runtime === 'deno' ? 'imports' : 'dependencies'];
      for (const [index, [name, range]] of Object.entries(COMMON_PEERS).entries()) {
        expect(actual[name], name).toBe(
          runtime !== 'deno' ? range : index < count ? `npm:${name}@${range}` : undefined,
        );
      }
      const note =
        'Added the OpenTelemetry peers telemetry-plugin needs: Bigtable pulls @opentelemetry/resources 1, which npm would otherwise hoist in their place.';
      expect(h.logs.filter((line) => line === note)).toHaveLength(
        runtime !== 'deno' && count < 4 ? 1 : 0,
      );
    }
  },
);

function harness() {
  const fs = createFakeFs();
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    fs,
    logs,
    errors,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      }),
  };
}

function dependencies(h: ReturnType<typeof harness>): Record<string, string> {
  return (
    JSON.parse(h.fs.read('/work/svc/package.json')) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;
}

const EXPORTER = '@opentelemetry/exporter-trace-otlp-http';
const HOOK = '@opentelemetry/instrumentation';
const IOREDIS = '@opentelemetry/instrumentation-ioredis';
const REDIS = '@opentelemetry/instrumentation-redis';

it('V10-50 records the OTLP exporter in a workspace root when telemetry is added to a member', async () => {
  const h = harness();
  expect(await h.run(['new', 'ws', '--workspace', '--runtime', 'node'])).toBe(0);
  expect(await h.run(['g', 'app', 'api', '--template', 'rest', '--dir', '/work/ws'])).toBe(0);
  expect(await h.run(['add', 'telemetry', '--dir', '/work/ws/apps/api']), h.errors.join('\n')).toBe(
    0,
  );
  expect(JSON.parse(h.fs.read('/work/ws/package.json')).dependencies[EXPORTER]).toBe(
    CLIENT_RANGES[EXPORTER],
  );
});

/** Project → the packages `add telemetry` must record, and the option it names. */
const TABLE: ReadonlyArray<{
  readonly label: string;
  readonly scaffold: readonly string[];
  readonly present: readonly string[];
  readonly absent: readonly string[];
  readonly option: string | undefined;
}> = [
  {
    label: 'a Node project with no Redis',
    scaffold: ['--template', 'rest', '--runtime', 'node'],
    present: [EXPORTER, HOOK],
    absent: [IOREDIS, REDIS],
    option: undefined,
  },
  {
    label: 'a Node project on ioredis',
    scaffold: ['--template', 'microservice', '--runtime', 'node', '--broker', 'redis'],
    present: [EXPORTER, HOOK, IOREDIS],
    absent: [REDIS],
    option: 'instrumentations: { ioredis: true }',
  },
  {
    label: 'a Node project on node-redis',
    scaffold: [
      '--template',
      'microservice',
      '--runtime',
      'node',
      '--broker',
      'redis',
      '--redis-client',
      'node-redis',
    ],
    present: [EXPORTER, HOOK, REDIS],
    absent: [IOREDIS],
    option: 'instrumentations: { redis: true }',
  },
  {
    label: 'a Bun project on ioredis',
    scaffold: ['--template', 'microservice', '--runtime', 'bun', '--broker', 'redis'],
    present: [EXPORTER],
    absent: [HOOK, IOREDIS, REDIS],
    option: undefined,
  },
];

describe('setu add telemetry (M131a X88-10)', () => {
  it.each(TABLE)('$label', async ({ scaffold, present, absent, option }) => {
    const h = harness();
    expect(await h.run(['new', 'svc', ...scaffold])).toBe(0);
    expect(await h.run(['add', 'telemetry', '--dir', '/work/svc']), h.errors.join('\n')).toBe(0);
    const deps = dependencies(h);
    for (const name of present) expect(deps[name], name).toBe(CLIENT_RANGES[name]);
    for (const name of absent) expect(deps[name], name).toBeUndefined();
    const guidance = h.logs.join('\n');
    if (option === undefined) {
      expect(guidance).not.toContain('instrumentations:');
    } else {
      expect(guidance).toContain(option);
      expect(guidance).toContain('./instrumentation.mjs');
    }
  });

  it('records the exporter in a Deno import map, with no Node hook', async () => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);
    expect(await h.run(['add', 'telemetry', '--dir', '/work/svc'])).toBe(0);
    const imports = h.fs.read('/work/svc/deno.json');
    expect(imports).toContain(`"${EXPORTER}"`);
    expect(imports).not.toContain(`"${HOOK}"`);
  });
});

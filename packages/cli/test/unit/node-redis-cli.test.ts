import { describe, expect, it } from 'vitest';
import baseline from '../fixtures/redis-develop-outputs.json' with { type: 'json' };
import { redisDefaultOutputs } from '../fixtures/redis-default-outputs.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { parseArgs } from '../../src/args.ts';
import { resolveNewChoices } from '../../src/commands/new-interactive.ts';
import { readWorkspaceManifest, WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';
import { transportSpec } from '../../src/workspace/transport.ts';
import { withClientDependencies, CLIENT_RANGES } from '../../src/templates/client-dependencies.ts';
import { resolveHost } from '../../src/templates/project-files.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { nodeRedisClientCall } from '../../src/templates/node-redis.ts';

function harness() {
  const fs = createFakeFs();
  const errors: string[] = [];
  return {
    fs,
    errors,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: (line) => errors.push(line),
      }),
  };
}

describe('node-redis CLI', () => {
  it('renders the client call in the layout each project formatter keeps', () => {
    // Short single-line read: one line.
    expect(nodeRedisClientCall("process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'")).toBe(
      "nodeRedisClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')",
    );
    // A Deno read continues at 10 for a property at 8: the argument moves one level in.
    expect(
      nodeRedisClientCall("Deno.env.get('REDIS_URL') ??\n          'redis://127.0.0.1:6379'"),
    ).toBe(
      "nodeRedisClient(\n          Deno.env.get('REDIS_URL') ??\n            'redis://127.0.0.1:6379',\n        )",
    );
    // A single-line read too wide for column 10 after `client: ` wraps as deno fmt does.
    const read = "config.get<string>('REDIS_URL', { default: 'redis://127.0.0.1:6379' })";
    expect(nodeRedisClientCall(read)).toBe(`nodeRedisClient(\n          ${read},\n        )`);
  });

  it('keeps the node-redis configuration classifiable: setu check is clean and the helper is local', async () => {
    const h = harness();
    expect(
      await h.run([
        'new',
        'svc',
        '--template',
        'microservice',
        '--broker',
        'redis',
        '--redis-client',
        'node-redis',
        '--devtool',
      ]),
    ).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    // No third-party import in the configuration: the classifier refuses one.
    expect(config).not.toMatch(/from ['"]redis['"]/);
    expect(config).toContain("import { nodeRedisClient } from './src/node-redis.ts';");
    expect(config).toContain("import { DEVTOOL_SOURCES } from './src/devtool/diagnostics.ts';");
    const helper = h.fs.read('/work/svc/src/node-redis.ts');
    expect(helper).toContain("import { createClient } from 'redis';");
    expect(helper).toContain(
      "import { fromNodeRedis, type NodeRedisAdapter } from '@setu-ts/common';",
    );
    expect(helper).toContain('return fromNodeRedis(createClient({ url }));');
    const out: string[] = [];
    const check = await runCli(['check', '--dir', '/work/svc'], {
      fs: h.fs,
      cwd: '/work',
      now: () => 0,
      log: (line) => out.push(line),
      error: (line) => out.push(line),
    });
    expect(check, out.join('\n')).toBe(0);
    expect(out.join('\n')).not.toContain('unclassifiable');
    expect(out.join('\n')).toContain('0 error(s), 0 warning(s)');
  });

  it('omits redisClient for an explicit ioredis workspace', async () => {
    const h = harness();
    expect(
      await h.run([
        'new',
        'ws',
        '--workspace',
        '--transport',
        'redis',
        '--redis-client',
        'ioredis',
      ]),
    ).toBe(0);
    expect(JSON.parse(h.fs.read(`/work/ws/${WORKSPACE_MANIFEST}`))).not.toHaveProperty(
      'redisClient',
    );
  });

  it('refuses --redis-client for setu add on Workers', async () => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--runtime', 'cloudflare-workers'])).toBe(0);
    expect(
      await h.run([
        'add',
        'messaging',
        '--broker',
        'redis',
        '--redis-client',
        'node-redis',
        '--dir',
        '/work/svc',
      ]),
    ).toBe(2);
    expect(h.errors.join('\n')).toContain('--redis-client cannot apply on Cloudflare Workers');
  });

  it('cancels at the Redis client question', async () => {
    const result = await resolveNewChoices(
      parseArgs([
        'svc',
        '--runtime',
        'node',
        '--template',
        'microservice',
        '--style',
        'functional',
        '--broker',
        'redis',
        '--queue',
        'memory',
      ]),
      { select: () => Promise.resolve({ kind: 'cancelled' }) },
      () => {},
    );
    expect(result.kind).toBe('cancelled');
  });

  it('recognises a double-quoted helper import: no second import and no import note', async () => {
    const fs = createFakeFs();
    const logs: string[] = [];
    const run = (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      });
    expect(
      await run([
        'new',
        'svc',
        '--template',
        'microservice',
        '--broker',
        'redis',
        '--redis-client',
        'node-redis',
      ]),
    ).toBe(0);
    const path = '/work/svc/setu.config.ts';
    const doubled = fs
      .read(path)
      .replace("from './src/node-redis.ts';", 'from "./src/node-redis.ts";');
    await fs.writeFile(path, new TextEncoder().encode(doubled));
    logs.length = 0;
    expect(
      await run([
        'add',
        'queue',
        '--queue',
        'redis',
        '--redis-client',
        'node-redis',
        '--dir',
        '/work/svc',
      ]),
    ).toBe(0);
    const config = fs.read(path);
    expect(config.match(/from ['"]\.\/src\/node-redis\.ts['"]/g)).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('Import nodeRedisClient');
  });

  it('keeps every ioredis variant byte-identical to captured develop output', async () => {
    // Except the one deliberate change: `setu add` on Deno wrote its call on one
    // line, which the project's own `deno fmt --check` refused; it is laid out now.
    const read = "url: Deno.env.get('REDIS_URL') ??\n          'redis://127.0.0.1:6379'";
    const joined = "url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379'";
    const relaid: Record<string, readonly [string, string]> = {
      'deno/add-messaging/work/app/setu.config.ts': [
        `      MessagingPlugin({ broker: 'redis-streams', ${read} }),\n`,
        `      MessagingPlugin({\n        broker: 'redis-streams',\n        ${joined},\n      }),\n`,
      ],
      'deno/add-queue/work/app/setu.config.ts': [
        `      QueuePlugin({  processors: [...QUEUE_PROCESSORS] ,  adapter: 'redis', ${read}  }),\n`,
        `      QueuePlugin({\n        processors: [...QUEUE_PROCESSORS],\n        adapter: 'redis',\n        ${joined},\n      }),\n`,
      ],
    };
    const expected: Record<string, string> = { ...baseline };
    for (const [path, [before, after]] of Object.entries(relaid)) {
      expect(expected[path]).toContain(before);
      expected[path] = expected[path]!.replace(before, after);
    }
    expect(await redisDefaultOutputs()).toEqual(expected);
  });

  it.each([
    ['messagingArgs', "{ broker: 'redis-streams', client: nodeRedisClient(endpoint) }"],
    ['queueArgs', "{ adapter: 'redis', client: nodeRedisClient(endpoint) }"],
    ['cacheArgs', "{ store: 'redis', options: { client: nodeRedisClient(endpoint) } }"],
    [
      'schedulerArgs',
      "{ distributedLock: { enabled: true, storage: 'redis', client: nodeRedisClient(endpoint) } }",
    ],
    [
      'backplaneArgs',
      "{ transport: 'redis', client: nodeRedisClient(endpoint), subscriber: nodeRedisClient(endpoint) }",
    ],
  ] as const)('renders the node-redis %s literal', (arm, expected) => {
    const spec = transportSpec('redis', 'node-redis');
    expect(spec[arm]!('endpoint')).toBe(expected);
    expect(spec.messagingClients).toEqual(['redis']);
    expect(spec.queueClients).toEqual(['redis']);
  });

  it.each(['node', 'deno', 'bun'])(
    'scaffolds standalone imports and dependencies on %s',
    async (runtime) => {
      const h = harness();
      expect(
        await h.run([
          'new',
          'svc',
          '--runtime',
          runtime,
          '--template',
          'microservice',
          '--broker',
          'redis',
          '--queue',
          'redis',
          '--redis-client',
          'node-redis',
        ]),
      ).toBe(0);
      const config = h.fs.read('/work/svc/setu.config.ts');
      expect(config.match(/nodeRedisClient\(/g)).toHaveLength(2);
      expect(config).not.toMatch(/from ['"]redis['"]/);
      expect(config.match(/from ['"]\.\/src\/node-redis\.ts['"]/g)).toHaveLength(1);
      expect(h.fs.read('/work/svc/src/node-redis.ts')).toContain("from 'redis'");
      expect(config.match(/from ['"]@setu-ts\/common['"]/g)).toHaveLength(1);
      const manifest = h.fs.read(`/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`);
      expect(manifest).toContain(runtime === 'deno' ? 'npm:redis@6.x' : '"redis": "6.x"');
      expect(manifest).not.toContain('ioredis');
    },
  );

  it.each(['node', 'deno'])(
    'inherits the workspace choice for generate app and all five add arms on %s',
    async (runtime) => {
      const h = harness();
      expect(
        await h.run([
          'new',
          'ws',
          '--workspace',
          '--runtime',
          runtime,
          '--transport',
          'redis',
          '--redis-client',
          'node-redis',
        ]),
      ).toBe(0);
      expect(JSON.parse(h.fs.read(`/work/ws/${WORKSPACE_MANIFEST}`)).redisClient).toBe(
        'node-redis',
      );
      expect(
        await h.run(['generate', 'app', 'svc', '--template', 'rest', '--dir', '/work/ws']),
      ).toBe(0);
      for (const plugin of ['cache', 'scheduler', 'realtime-backplane', 'messaging', 'queue']) {
        expect(
          await h.run(['add', plugin, '--dir', '/work/ws/apps/svc']),
          h.errors.join('\n'),
        ).toBe(0);
      }
      const config = h.fs.read('/work/ws/apps/svc/setu.config.ts');
      expect(config.match(/nodeRedisClient\(/g)).toHaveLength(6);
      expect(config).not.toMatch(/from ['"]redis['"]/);
      expect(config.match(/from ['"]\.\/src\/node-redis\.ts['"]/g)).toHaveLength(1);
      expect(h.fs.read('/work/ws/apps/svc/src/node-redis.ts')).toContain("from 'redis'");
      expect(config.match(/from ['"]@setu-ts\/common['"]/g)).toHaveLength(1);
      const manifest = h.fs.read(
        `/work/ws/apps/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`,
      );
      expect(manifest).toContain(runtime === 'deno' ? 'npm:redis@6.x' : '"redis": "6.x"');
      expect(manifest).not.toContain('ioredis');
    },
  );

  it.each(['messaging', 'queue'])(
    'adds standalone %s with the existing manifest writer',
    async (plugin) => {
      const h = harness();
      await h.run(['new', 'svc', '--template', 'rest']);
      expect(
        await h.run([
          'add',
          plugin,
          `--${plugin === 'messaging' ? 'broker' : 'queue'}`,
          'redis',
          '--redis-client',
          'node-redis',
          '--dir',
          '/work/svc',
        ]),
      ).toBe(0);
      expect(h.fs.read('/work/svc/package.json')).toContain('"redis": "6.x"');
      expect(h.fs.read('/work/svc/setu.config.ts')).toMatch(/nodeRedisClient\(/);
      expect(h.fs.read('/work/svc/setu.config.ts')).toContain(
        "import { nodeRedisClient } from './src/node-redis.ts';",
      );
      expect(h.fs.read('/work/svc/src/node-redis.ts')).toContain("from 'redis'");
    },
  );

  it.each([
    [['new', 'svc', '--redis-client', 'node-redis'], 'requires a Redis arm'],
    [['new', 'svc', '--redis-client', 'unknown'], 'Unknown --redis-client'],
    [['new', 'svc', '--redis-client'], 'Unknown --redis-client'],
    [
      [
        'new',
        'svc',
        '--runtime',
        'cloudflare-workers',
        '--broker',
        'redis',
        '--redis-client',
        'node-redis',
      ],
      'Cloudflare Workers',
    ],
  ] as const)('refuses new %j by name with EXIT_USAGE', async (args, message) => {
    const h = harness();
    expect(await h.run(args)).toBe(2);
    expect(h.errors.join('\n')).toContain(message);
    expect(h.fs.writes).toHaveLength(0);
  });

  it.each([
    ['generate', 'app', 'svc'],
    ['add', 'cache'],
  ])('refuses per-member selection with EXIT_USAGE: %j', async (...command) => {
    const h = harness();
    await h.run(['new', 'ws', '--workspace']);
    await h.run(['generate', 'app', 'svc', '--dir', '/work/ws']);
    const dir = command[0] === 'add' ? '/work/ws/apps/svc' : '/work/ws';
    expect(await h.run([...command, '--dir', dir, '--redis-client', 'node-redis'])).toBe(2);
    expect(h.errors.join('\n')).toContain('--redis-client');
  });

  it.each([
    ['cache', '--redis-client', 'node-redis'],
    ['messaging', '--broker', 'redis', '--redis-client', 'wrong'],
  ])('refuses a standalone add without a valid Redis selection: %j', async (...args) => {
    const h = harness();
    await h.run(['new', 'svc']);
    expect(await h.run(['add', ...args, '--dir', '/work/svc'])).toBe(2);
    expect(h.errors.join('\n')).toContain('--redis-client');
  });

  it('refuses an unknown stored redisClient by name', async () => {
    const h = harness();
    await h.run(['new', 'ws', '--workspace', '--transport', 'redis']);
    expect(await h.run(['generate', 'app', 'existing', '--dir', '/work/ws'])).toBe(0);
    const path = `/work/ws/${WORKSPACE_MANIFEST}`;
    await h.fs.writeFile(
      path,
      new TextEncoder().encode(
        JSON.stringify({ ...JSON.parse(h.fs.read(path)), redisClient: 'unknown' }),
      ),
    );
    expect(await readWorkspaceManifest(h.fs, '/work/ws')).toEqual({
      ok: false,
      problem: { kind: 'unknown-redis-client', redisClient: 'unknown' },
    });
    expect(await h.run(['generate', 'app', 'svc', '--dir', '/work/ws'])).toBe(1);
    expect(h.errors.join('\n')).toContain('unknown redisClient "unknown"');
    expect(await h.run(['add', 'cache', '--dir', '/work/ws/apps/existing'])).toBe(1);
  });

  it.each(['redis', 'memory'])(
    'asks Redis client only after choosing a Redis broker or queue (%s)',
    async (broker) => {
      const questions: string[] = [];
      const result = await resolveNewChoices(
        parseArgs([
          'svc',
          '--runtime',
          'node',
          '--template',
          'microservice',
          '--style',
          'functional',
          '--broker',
          broker,
          '--queue',
          'memory',
          '--logger',
          'console',
        ]),
        {
          select: (question, choices) => {
            questions.push(question);
            return Promise.resolve({ kind: 'answer' as const, value: choices[0]!.value });
          },
        },
        () => {},
      );
      expect(questions.includes('Redis client?')).toBe(broker === 'redis');
      expect(result.kind).toBe('resolved');
    },
  );

  it('adds redis through withClientDependencies', () => {
    const host = withClientDependencies(resolveHost(MINIMAL_HOST, 'deno'), ['redis']);
    expect(CLIENT_RANGES['redis']).toBe('6.x');
    expect(host.extraDependencies['redis']).toBe('6.x');
    expect(host.extraImports['redis']).toBe('npm:redis@6.x');
  });
});

/**
 * Tests for what `setu add` writes and says when it selects a backend: broker
 * start and test guidance, the README transport section, mail options read from
 * the environment, a bare provider call given the chosen options, the ignore
 * entries a database arm needs, the existing Drizzle config, and the wiring gate
 * for backends that need options.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';
import { runCli } from '../../../src/cli.ts';
import { unregisteredPluginFindings } from '../../../src/diagnostics/wiring.ts';
import { LOCAL_TRANSPORT_HEADING } from '../../../src/templates/project-files.ts';
import { withServedRoutes } from '../../../src/commands/add-view.ts';
import { CONFIGURED_PROVIDERS, ZERO_CONFIG_WIRINGS } from '../../../src/utils/plugin-wirings.ts';

/** A Node rest project scaffolded into a fake filesystem, and a runner for it. */
async function project(args: readonly string[] = [], template = 'rest', runtime = 'node') {
  const fs = createFakeFs();
  const out = createRecorder();
  const err = createRecorder();
  const run = (argv: readonly string[], cwd = '/work/shop') =>
    runCli(argv, {
      fs,
      cwd,
      log: out.sink,
      error: err.sink,
      now: () => 0,
      secret: () => 's'.repeat(64),
      portAvailable: () => Promise.resolve(true),
    });
  expect(
    await run(
      [
        'new',
        'shop',
        ...(template === 'minimal' ? [] : ['--template', template]),
        '--runtime',
        runtime,
        '--yes',
        ...args,
      ],
      '/work',
    ),
    err.text(),
  ).toBe(0);
  (out.lines as string[]).length = 0;
  return { fs, out, err, run, read: (path: string) => fs.read(`/work/shop/${path}`) };
}

describe('setu add backend guidance', () => {
  // Every connected broker, not Redis alone, as data: the start line names the
  // Compose service the broker's spec declares.
  for (const [broker, label, service] of [
    ['rabbitmq', 'RabbitMQ', 'rabbitmq'],
    ['nats', 'NATS', 'nats'],
    ['kafka', 'Kafka', 'kafka'],
    ['redis', 'Redis', 'redis'],
  ] as const) {
    it(`tells a ${broker} project that its app and tests connect, and how to start it`, async () => {
      const p = await project();
      expect(await p.run(['add', 'messaging', '--broker', broker]), p.err.text()).toBe(0);
      const text = p.out.text();
      expect(text).toContain(`The app and generated tests now connect to ${label} at`);
      expect(text).toContain(
        `Start ${label}: docker compose -f docker/compose.yaml up -d ${service}`,
      );
      expect(text).toContain(
        "createTestApp({ app: await createApp(), without: ['messaging-plugin'], overrides: [MessagingPlugin()] })",
      );
    });
  }

  it('adds the local transport section to the README once, before ## Run', async () => {
    const p = await project();
    expect(p.read('README.md')).not.toContain(LOCAL_TRANSPORT_HEADING);
    expect(await p.run(['add', 'messaging', '--broker', 'rabbitmq']), p.err.text()).toBe(0);
    const readme = p.read('README.md');
    expect(readme.indexOf(LOCAL_TRANSPORT_HEADING)).toBeGreaterThan(0);
    expect(readme.indexOf(LOCAL_TRANSPORT_HEADING)).toBeLessThan(readme.indexOf('## Run'));
    expect(readme.replace(/\s+/g, ' ')).toContain('A container does not read `.env`');
    expect(p.out.text()).toContain('README.md gains the Local transport services section.');
    expect(await p.run(['add', 'queue', '--queue', 'redis']), p.err.text()).toBe(0);
    expect(p.read('README.md').split(LOCAL_TRANSPORT_HEADING)).toHaveLength(2);
  });

  it('prints the section when the README has no ## Run heading to place it before', async () => {
    const p = await project();
    await p.fs.writeFile('/work/shop/README.md', new TextEncoder().encode('# shop\n'));
    expect(await p.run(['add', 'messaging', '--broker', 'nats']), p.err.text()).toBe(0);
    expect(p.read('README.md')).toBe('# shop\n');
    expect(p.out.text()).toContain('README.md has no "## Run" section; add this one before it:');
  });

  it('writes the same section from setu new --broker', async () => {
    const p = await project(['--broker', 'rabbitmq'], 'microservice');
    expect(p.read('README.md')).toContain(LOCAL_TRANSPORT_HEADING);
    expect(p.read('README.md').replace(/\s+/g, ' ')).toContain('A container does not read `.env`');
  });

  it('prints mail options read from the environment and writes their variables', async () => {
    for (const [provider, variables, line] of [
      [
        'smtp',
        { SMTP_HOST: 'localhost', SMTP_PORT: '1025' },
        "options: { host: process.env.SMTP_HOST || 'localhost', port: Number(process.env.SMTP_PORT || '587') }",
      ],
      [
        'sendgrid',
        { SENDGRID_API_KEY: '' },
        "options: { apiKey: process.env.SENDGRID_API_KEY || '' }",
      ],
      ['ses', {}, 'options: {}'],
    ] as const) {
      const p = await project();
      expect(await p.run(['add', 'mail', '--provider', provider]), p.err.text()).toBe(0);
      expect(p.out.text()).toContain(`MailPlugin({ provider: '${provider}', ${line} })`);
      for (const [name, value] of Object.entries(variables)) {
        expect(p.read('.env')).toContain(`\n${name}=${value}\n`);
        expect(p.read('.env.example')).toContain(`\n${name}=\n`);
      }
      if (provider === 'ses') expect(p.read('.env')).not.toContain('AWS_REGION');
    }
  });

  it("gives the CLI's own bare provider call the chosen options on a re-add", async () => {
    const p = await project();
    expect(await p.run(['add', 'cache']), p.err.text()).toBe(0);
    expect(p.read('setu.config.ts')).toContain('CachePlugin(),');
    expect(await p.run(['add', 'cache', '--store', 'redis']), p.err.text()).toBe(0);
    const config = p.read('setu.config.ts');
    expect(config).not.toContain('CachePlugin(),');
    expect(config.replace(/\s+/g, ' ')).toMatch(/CachePlugin\(\{ store: 'redis'/);
    expect(p.out.text()).toContain(
      'CachePlugin() in setu.config.ts now takes the selected options.',
    );
    expect(p.out.text()).not.toContain('the existing call was preserved');
  });

  it('adds the node-redis import when the rewritten call needs it', async () => {
    const p = await project();
    expect(await p.run(['add', 'cache']), p.err.text()).toBe(0);
    expect(
      await p.run(['add', 'cache', '--store', 'redis', '--redis-client', 'node-redis']),
      p.err.text(),
    ).toBe(0);
    const config = p.read('setu.config.ts');
    expect(config).toContain("import { nodeRedisClient } from './src/node-redis.ts';");
    expect(config).toContain('nodeRedisClient(');
  });

  it('leaves a provider call that already has arguments, and prints the options', async () => {
    const p = await project();
    expect(await p.run(['add', 'cache']), p.err.text()).toBe(0);
    const config = p.read('setu.config.ts').replace('CachePlugin(),', 'CachePlugin({ ttl: 60 }),');
    await p.fs.writeFile('/work/shop/setu.config.ts', new TextEncoder().encode(config));
    expect(await p.run(['add', 'cache', '--store', 'redis']), p.err.text()).toBe(0);
    expect(p.read('setu.config.ts')).toContain('CachePlugin({ ttl: 60 }),');
    expect(p.out.text()).toContain('the existing call was preserved');
  });

  it('ignores the SQLite file and the Drizzle output once', async () => {
    const p = await project();
    for (let run = 0; run < 2; run++)
      expect(
        await p.run(['add', 'database', '--type', 'drizzle', '--dialect', 'sqlite']),
        p.err.text(),
      ).toBe(0);
    for (const file of ['.gitignore', '.dockerignore']) {
      const lines = p.read(file).split('\n');
      expect(lines.filter((line) => line === 'local.db')).toHaveLength(1);
      expect(lines.filter((line) => line === 'local.db-*')).toHaveLength(1);
    }
    expect(
      p
        .read('.prettierignore')
        .split('\n')
        .filter((line) => line === 'drizzle/'),
    ).toHaveLength(1);
  });

  it('ignores nothing extra for a PostgreSQL database', async () => {
    const p = await project();
    const before = p.read('.gitignore');
    expect(
      await p.run(['add', 'database', '--type', 'drizzle', '--dialect', 'postgresql']),
      p.err.text(),
    ).toBe(0);
    expect(p.read('.gitignore')).toBe(before);
  });

  it('says when an existing drizzle.config.ts is kept, and when its dialect differs', async () => {
    const p = await project();
    expect(
      await p.run(['add', 'database', '--type', 'drizzle', '--dialect', 'sqlite']),
      p.err.text(),
    ).toBe(0);
    (p.out.lines as string[]).length = 0;
    expect(
      await p.run(['add', 'database', '--type', 'drizzle', '--dialect', 'sqlite']),
      p.err.text(),
    ).toBe(0);
    expect(p.out.text()).toContain('left drizzle.config.ts unchanged: already present.');
    (p.out.lines as string[]).length = 0;
    expect(
      await p.run(['add', 'database', '--type', 'drizzle', '--dialect', 'postgresql']),
      p.err.text(),
    ).toBe(0);
    expect(p.out.text()).toContain(
      "left drizzle.config.ts unchanged: it uses dialect 'sqlite', not 'postgresql'.",
    );
    expect(p.read('drizzle.config.ts')).toContain("dialect: 'sqlite'");
  });

  it('reports an installed database or vector-store plugin that nothing registers', () => {
    for (const [pkg, symbol] of [
      ['database-plugin', 'DatabasePlugin'],
      ['vector-store-plugin', 'VectorStorePlugin'],
    ] as const) {
      expect(unregisteredPluginFindings('', new Set([pkg]))).toEqual([
        { kind: 'plugin-unregistered', pkg, symbol },
      ]);
      expect(
        unregisteredPluginFindings(
          `import { ${symbol} } from '@setu-ts/${pkg}';\nexport const p = ${symbol}({});`,
          new Set([pkg]),
        ),
      ).toEqual([]);
    }
  });

  it('refuses the decorator plugin in a functional project, naming the class-based scaffold', async () => {
    const p = await project();
    expect(await p.run(['add', 'decorator'])).toBe(1);
    expect(p.err.text()).toContain('This project uses the functional style.');
    expect(p.err.text()).toContain('new <name> --template rest --style class-based');
    expect(p.read('package.json')).not.toContain('decorator-plugin');
    const classBased = await project(['--style', 'class-based']);
    expect(await classBased.run(['add', 'decorator']), classBased.err.text()).toBe(0);
  });

  for (const [adapter, variable, imports, service, client] of [
    ['qdrant', 'QDRANT_URL', 'QdrantClient', 'qdrant', '@qdrant/js-client-rest'],
    ['pgvector', 'DATABASE_URL', "drizzle } from 'drizzle-orm/node-postgres'", 'pgvector', 'pg'],
  ] as const) {
    it(`writes the ${adapter} adapter module, its connection and a Compose service`, async () => {
      const p = await project();
      expect(await p.run(['add', 'vector-store', '--adapter', adapter]), p.err.text()).toBe(0);
      const module = p.read('src/vector-store.ts');
      expect(module).toContain(imports);
      expect(module).toContain(`process.env.${variable} ||`);
      expect(module).toContain('export function vectorStoreAdapter()');
      expect(p.read('.env')).toContain(`\n${variable}=`);
      expect(p.read('.env.example')).toContain(`\n${variable}=\n`);
      expect(p.read('docker/compose.yaml')).toContain(`  ${service}:`);
      const text = p.out.text();
      expect(text).toContain(
        "In setu.config.ts: VectorStorePlugin({ adapter: vectorStoreAdapter(), collections: [{ name: 'documents', dimensions: 768 }] })",
      );
      expect(text).toContain(
        "Import { VectorStorePlugin } from '@setu-ts/vector-store-plugin' for it.",
      );
      expect(text).toContain("Import { vectorStoreAdapter } from './src/vector-store.ts' for it.");
      expect(text).toContain(client);
      // A second run keeps the module and prints the service the file lacks no more.
      (p.out.lines as string[]).length = 0;
      expect(await p.run(['add', 'vector-store', '--adapter', adapter]), p.err.text()).toBe(0);
      expect(p.out.text()).toContain('left src/vector-store.ts unchanged: already present.');
    });
  }

  it('prints the service an existing Compose file lacks for the vector store', async () => {
    const p = await project();
    expect(await p.run(['add', 'messaging', '--broker', 'nats']), p.err.text()).toBe(0);
    (p.out.lines as string[]).length = 0;
    expect(await p.run(['add', 'vector-store', '--adapter', 'qdrant']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('docker/compose.yaml exists and has no qdrant service');
    expect(p.read('docker/compose.yaml')).not.toContain('qdrant:');
  });

  it('gives smtp mail a local Mailpit, its port and the offline test override', async () => {
    const p = await project();
    expect(await p.run(['add', 'mail', '--provider', 'smtp']), p.err.text()).toBe(0);
    expect(p.read('docker/compose.yaml')).toContain('  mailpit:');
    expect(p.read('.env')).toContain('\nSMTP_PORT=1025\n');
    expect(p.out.text()).toContain(
      "createTestApp({ app: await createApp(), without: ['mail-plugin'], overrides: [MailPlugin()] })",
    );
  });

  it('says nothing is already passed right after writing a Redis lock', async () => {
    const p = await project();
    expect(await p.run(['add', 'scheduler', '--lock', 'redis']), p.err.text()).toBe(0);
    expect(p.read('setu.config.ts')).toContain('distributedLock');
    expect(p.out.text()).not.toContain('already passes these options');
  });

  it('wires zero-config providers on Workers, but not an in-memory cache or store', async () => {
    const p = await project([], 'minimal', 'cloudflare-workers');
    expect(await p.run(['add', 'resilience']), p.err.text()).toBe(0);
    expect(p.read('setu.config.ts')).toContain('ResiliencePlugin(),');
    for (const [pkg, call, arm] of [
      ['cache', 'CachePlugin', "cache: { binding: 'CACHE_KV' }"],
      ['storage', 'StoragePlugin', "storage: { binding: 'UPLOADS' }"],
    ] as const) {
      (p.out.lines as string[]).length = 0;
      expect(await p.run(['add', pkg]), p.err.text()).toBe(0);
      expect(p.read('setu.config.ts')).not.toContain(`${call}()`);
      expect(p.out.text()).toContain(`CloudflarePlugin({ env, ${arm} })`);
    }
  });

  it('names the security guard a marked MCP route needs, and prints di and sdk guidance', async () => {
    const p = await project();
    expect(await p.run(['add', 'mcp']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('Each marked route also needs a security guard');
    (p.out.lines as string[]).length = 0;
    expect(await p.run(['add', 'di']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('Register DiPlugin() in setu.config.ts.');
    expect(p.out.text()).toContain("Import { DiPlugin } from '@setu-ts/di-plugin' for it.");
    (p.out.lines as string[]).length = 0;
    expect(await p.run(['add', 'sdk']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('The client script boots the app and writes its typed client');
  });

  it('prints the full-stack auth arm and when JWT_SECRET is read', async () => {
    const p = await project([], 'full-stack');
    expect(await p.run(['add', 'auth']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('auth: { signIn: { providers: [] }, local: { verify:');
    expect(p.out.text()).toContain('JWT_SECRET (written to the dotenv file) is read only when');
  });

  it('adds the view routes to the README and names the one StaticPlugin', async () => {
    const p = await project();
    expect(await p.run(['add', 'view']), p.err.text()).toBe(0);
    const readme = p.read('README.md');
    expect(readme).toContain('- `/ui` — the example page');
    expect(readme).toContain('- `/assets` — its built CSS');
    expect(p.out.text()).toContain("It is the project's one StaticPlugin");
    expect(withServedRoutes(readme)).toBeUndefined();
    expect(withServedRoutes('# x\n')).toBeUndefined();
    expect(withServedRoutes('# x\n\n## What it serves\n\nNothing yet.\n')).toBeUndefined();
  });

  it('reports every printed-registration provider that nothing registers, with three exceptions', () => {
    for (const [pkg, { symbol }] of CONFIGURED_PROVIDERS) {
      expect(unregisteredPluginFindings('', new Set([pkg]))).toEqual([
        { kind: 'plugin-unregistered', pkg, symbol },
      ]);
      expect(ZERO_CONFIG_WIRINGS.has(pkg)).toBe(false);
    }
    expect(CONFIGURED_PROVIDERS.has('auth-plugin')).toBe(false);
    expect(
      unregisteredPluginFindings(
        "import { transportPlugins } from './src/transport/index.ts';\nexport const p = [...transportPlugins()];",
        new Set(['grpc-plugin']),
      ),
    ).toEqual([]);
    const workers = 'export function createApp(env = {}, waitUntil?: () => void) {}';
    expect(
      unregisteredPluginFindings(workers, new Set(['cache-plugin', 'storage-plugin'])),
    ).toEqual([]);
    expect(unregisteredPluginFindings('', new Set(['cache-plugin']))).toHaveLength(1);
  });
});

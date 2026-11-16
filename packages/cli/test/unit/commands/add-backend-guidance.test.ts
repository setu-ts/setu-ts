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
import { registersAssets, withServedRoutes } from '../../../src/commands/add-view.ts';
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
        "options: { host: process.env.SMTP_HOST || 'localhost', port: Number(process.env.SMTP_PORT || '1025') }",
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

  it('keeps the jobs barrel when it rewrites a bare QueuePlugin() call', async () => {
    const p = await project();
    expect(await p.run(['add', 'queue']), p.err.text()).toBe(0);
    // A config whose QueuePlugin() was written bare, with no jobs barrel import.
    const wired = p.read('setu.config.ts');
    const bare = wired
      .replace(/QueuePlugin\(\{\s*processors: \[\.\.\.QUEUE_PROCESSORS\]\s*\}\)/, 'QueuePlugin()')
      .replace(/import \{ QUEUE_PROCESSORS \} from '[^']+';\n/, '');
    expect(bare).toContain('QueuePlugin(),');
    expect(bare).not.toContain('QUEUE_PROCESSORS');
    await p.fs.writeFile('/work/shop/setu.config.ts', new TextEncoder().encode(bare));
    expect(await p.run(['add', 'queue', '--queue', 'redis']), p.err.text()).toBe(0);
    const config = p.read('setu.config.ts').replace(/\s+/g, ' ');
    expect(config).toMatch(/QueuePlugin\(\{ processors: \[\.\.\.QUEUE_PROCESSORS\], /);
    expect(config).toContain("adapter: 'redis'");
    expect(config).toMatch(/import \{ QUEUE_PROCESSORS \} from '\.\/src\/jobs\/index\.ts';/);
  });

  it('places the jobs barrel import correctly when an import follows createApp', async () => {
    const p = await project();
    expect(await p.run(['add', 'queue']), p.err.text()).toBe(0);
    const bare = p
      .read('setu.config.ts')
      .replace(/QueuePlugin\(\{\s*processors: \[\.\.\.QUEUE_PROCESSORS\]\s*\}\)/, 'QueuePlugin()')
      .replace(/import \{ QUEUE_PROCESSORS \} from '[^']+';\n/, '');
    // A valid config whose last import, a side-effect one, comes after the factory.
    const trailing = `${bare}\nimport './src/polyfill.ts';\nexport const id = 1;\n`;
    await p.fs.writeFile('/work/shop/setu.config.ts', new TextEncoder().encode(trailing));
    expect(await p.run(['add', 'queue', '--queue', 'redis']), p.err.text()).toBe(0);
    const config = p.read('setu.config.ts');
    expect(config).toContain(
      "import './src/polyfill.ts';\nimport { QUEUE_PROCESSORS } from './src/jobs/index.ts';\nexport const id = 1;",
    );
    expect(config.replace(/\s+/g, ' ')).toMatch(
      /QueuePlugin\(\{ processors: \[\.\.\.QUEUE_PROCESSORS\], /,
    );
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
    expect(p.err.text()).toContain(
      '(or --template microservice; full-stack has no class-based variant)',
    );
    expect(p.read('package.json')).not.toContain('decorator-plugin');
    const classBased = await project(['--style', 'class-based']);
    expect(await classBased.run(['add', 'decorator']), classBased.err.text()).toBe(0);
  });

  for (const [adapter, variable, imports, service, client] of [
    ['qdrant', 'QDRANT_URL', 'QdrantClient', 'qdrant', '@qdrant/js-client-rest@1.20.0'],
    ['pgvector', 'PGVECTOR_URL', "drizzle } from 'drizzle-orm/node-postgres'", 'pgvector', 'pg'],
  ] as const) {
    it(`writes the ${adapter} adapter module, its connection and a Compose service`, async () => {
      const p = await project();
      expect(await p.run(['add', 'vector-store', '--adapter', adapter]), p.err.text()).toBe(0);
      const module = p.read('src/vector-store.ts');
      expect(module).toContain(imports);
      expect(module).toContain(`process.env.${variable} ||`);
      expect(module).toContain('export function vectorStoreAdapter()');
      // pgvector's factory builds the pool from the URL, so it ends it at shutdown.
      if (adapter === 'pgvector') expect(module).toContain('onClose: () => db.$client.end()');
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

  it('pins the Qdrant client to the minor release of the Compose image', async () => {
    const p = await project();
    expect(await p.run(['add', 'vector-store', '--adapter', 'qdrant']), p.err.text()).toBe(0);
    const image = /image: qdrant\/qdrant:v(\d+\.\d+)\./.exec(p.read('docker/compose.yaml'))?.[1];
    const client = /@qdrant\/js-client-rest@(\d+\.\d+)\./.exec(p.out.text())?.[1];
    expect(image).toBeDefined();
    expect(client).toBe(image);
  });

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

  it('wires zero-config providers on Workers, and refuses an in-memory cache or store there', async () => {
    const p = await project([], 'minimal', 'cloudflare-workers');
    expect(await p.run(['add', 'resilience']), p.err.text()).toBe(0);
    expect(p.read('setu.config.ts')).toContain('ResiliencePlugin(),');
    for (const [pkg, arm, block] of [
      ['cache', "cache: { binding: 'CACHE_KV' }", 'KV'],
      ['storage', "storage: { binding: 'UPLOADS' }", 'R2'],
    ] as const) {
      (p.err.lines as string[]).length = 0;
      const manifest = p.read('package.json');
      expect(await p.run(['add', pkg])).toBe(2);
      expect(p.err.text()).toContain(
        `Cannot add @setu-ts/${pkg}-plugin to a cloudflare-workers project`,
      );
      expect(p.err.text()).toContain(
        `CloudflarePlugin({ env, ${arm} }) (setu add cloudflare registers it`,
      );
      expect(p.err.text()).toContain(`commented ${block} block`);
      expect(p.read('package.json')).toBe(manifest);
    }
  });

  it('refuses the socket vector-store adapters on Workers and does not ask for one there', async () => {
    const p = await project([], 'minimal', 'cloudflare-workers');
    for (const adapter of ['qdrant', 'pgvector']) {
      (p.err.lines as string[]).length = 0;
      expect(await p.run(['add', 'vector-store', '--adapter', adapter])).toBe(2);
      expect(p.err.text()).toContain(`--adapter ${adapter} cannot apply on Cloudflare Workers`);
      expect(p.err.text()).toContain("VectorizeVectorStore from '@setu-ts/cloudflare-plugin'");
      expect(p.read('package.json')).not.toContain('vector-store-plugin');
    }
    (p.out.lines as string[]).length = 0;
    expect(await p.run(['add', 'vector-store', '--adapter', 'memory']), p.err.text()).toBe(0);
    expect(p.out.text()).toContain('new VectorizeVectorStore({ index: env.DOCUMENTS_INDEX })');
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

  it('lists /assets only when StaticPlugin serves it', async () => {
    const p = await project();
    // A StaticPlugin serving another directory: the CSS registration is refused.
    const config = p.read('setu.config.ts');
    await p.fs.writeFile(
      '/work/shop/setu.config.ts',
      new TextEncoder().encode(
        "import { StaticPlugin } from '@setu-ts/static-plugin';\n" +
          config.replace(
            '...(devtool?.plugins ?? [])',
            "StaticPlugin({ root: './public' }),\n      ...(devtool?.plugins ?? [])",
          ),
      ),
    );
    expect(await p.run(['add', 'view']), p.err.text()).toBe(0);
    const readme = p.read('README.md');
    expect(readme).toContain('- `/ui` — the example page');
    expect(readme).not.toContain('- `/assets`');
    expect(withServedRoutes('# x\n\n## What it serves\n\n- `/` — hello\n', false)).not.toContain(
      '/assets',
    );
  });

  it('counts the CSS StaticPlugin call only as code in the factory, not a string, comment or helper', async () => {
    const call = "StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })";
    /** A config whose factory body holds `body`, with `before` above it. */
    const app = (body: string, before = '') =>
      `${before}export function createApp(): IKernelApplication {\n  ${body}\n}\n`;
    expect(registersAssets(app(`return createApplication({ plugins: [${call}] });`))).toBe(true);
    expect(
      registersAssets(
        app(
          'const plugins = [\n    StaticPlugin({\n      root: "./build/assets",\n      urlPrefix: "/assets",\n    }),\n  ];',
        ),
      ),
    ).toBe(true);
    expect(registersAssets(app(`const note = "${call}";`))).toBe(false);
    expect(registersAssets(app(`// ${call}\n  const x = 1;`))).toBe(false);
    expect(
      registersAssets(app("return [StaticPlugin({ root: './public', urlPrefix: '/assets' })];")),
    ).toBe(false);
    expect(
      registersAssets(app(`return [MyStaticPlugin(${call.slice('StaticPlugin'.length)})];`)),
    ).toBe(false);
    // A helper nobody calls, beside a factory that registers another directory.
    expect(
      registersAssets(
        app(
          "return [StaticPlugin({ root: './public' })];",
          `function unused() {\n  return ${call};\n}\n`,
        ),
      ),
    ).toBe(false);
    // No readable factory at all: fail closed.
    expect(registersAssets(`const plugins = [${call}];`)).toBe(false);
    expect(registersAssets("const broken = 'unterminated")).toBe(false);

    // Through `add view`: a string naming the call, beside a StaticPlugin serving
    // another directory, does not make the README claim /assets.
    const p = await project();
    const config = p.read('setu.config.ts');
    await p.fs.writeFile(
      '/work/shop/setu.config.ts',
      new TextEncoder().encode(
        "import { StaticPlugin } from '@setu-ts/static-plugin';\n" +
          `export const NOTE = "${call}";\n` +
          config.replace(
            '...(devtool?.plugins ?? [])',
            "StaticPlugin({ root: './public' }),\n      ...(devtool?.plugins ?? [])",
          ),
      ),
    );
    expect(await p.run(['add', 'view']), p.err.text()).toBe(0);
    expect(p.read('README.md')).toContain('- `/ui` — the example page');
    expect(p.read('README.md')).not.toContain('- `/assets`');
  });

  it('adds the view routes after the last bullet, wrapped or at the end of the file', () => {
    const routes = '- `/ui` — the example page `setu add view` wrote, rendered by ViewPlugin';
    // A last bullet with no line feed after it: the routes follow it, after the heading.
    const unterminated = withServedRoutes('# x\n\n## What it serves\n\n- `/` — hello')!;
    expect(unterminated.indexOf(routes)).toBeGreaterThan(unterminated.indexOf('- `/` — hello'));
    expect(unterminated.startsWith('# x\n\n## What it serves\n\n- `/` — hello\n- `/ui`')).toBe(
      true,
    );
    // A wrapped last bullet keeps its continuation line, and the next section stays after.
    const wrapped = withServedRoutes(
      '# x\n\n## What it serves\n\n- `/` — a long line\n  that wraps here\n\n## Run\n',
    )!;
    expect(wrapped).toContain('- `/` — a long line\n  that wraps here\n- `/ui`');
    expect(wrapped.indexOf('## Run')).toBeGreaterThan(wrapped.indexOf('- `/assets`'));
  });

  it('adds the local services section for Mailpit and Qdrant, and no test override on full-stack', async () => {
    for (const [args, service] of [
      [['add', 'mail', '--provider', 'smtp'], 'mailpit'],
      [['add', 'vector-store', '--adapter', 'qdrant'], 'qdrant'],
    ] as const) {
      const p = await project();
      expect(await p.run([...args]), p.err.text()).toBe(0);
      const readme = p.read('README.md');
      expect(readme).toContain('## Local transport services');
      expect(readme).toContain('`/health` reports each one down until it is listening');
      expect(readme.indexOf('## Local transport services')).toBeLessThan(readme.indexOf('## Run'));
      expect(p.read('docker/compose.yaml')).toContain(`  ${service}:`);
      expect(p.out.text()).toContain('README.md gains the Local transport services section.');
    }
    const rest = await project();
    expect(await rest.run(['add', 'mail', '--provider', 'smtp']), rest.err.text()).toBe(0);
    expect(rest.out.text()).toContain("without: ['mail-plugin']");
    const fullStack = await project([], 'full-stack');
    expect(await fullStack.run(['add', 'mail', '--provider', 'smtp']), fullStack.err.text()).toBe(
      0,
    );
    expect(fullStack.out.text()).toContain('Local mail goes to Mailpit');
    expect(fullStack.out.text()).not.toContain('createTestApp');
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

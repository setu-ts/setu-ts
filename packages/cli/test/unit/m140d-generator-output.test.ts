/** Regression samples for each approved M140d section. @module */
import { describe, expect, it } from 'vitest';
import { format } from 'prettier';
import ts from 'typescript';
import type { z } from 'zod';
import { runCli } from '../../src/cli.ts';
import { commandFlagsFor } from '../../src/flags.ts';
import { generateSchema } from '../../src/schematics/schema.ts';
import { generateEventHandler } from '../../src/schematics/event-handler.ts';
import { generateJob } from '../../src/schematics/job.ts';
import { generateMiddleware } from '../../src/schematics/middleware.ts';
import { moduleService } from '../../src/schematics/module-files.ts';
import { generateService } from '../../src/schematics/service.ts';
import { generateFullStackModule } from '../../src/schematics/module-full-stack.ts';
import { getTemplate } from '../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { withBrokerArgs, withQueueArgs, brokerEnvVariables } from '../../src/templates/broker.ts';
import { BROKERS, brokerSpec } from '../../src/workspace/transport.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import { PRETTIER_OPTIONS } from '../../src/templates/npm-tooling.ts';
import { ZERO_CONFIG_WIRINGS } from '../../src/utils/plugin-wirings.ts';
import { unregisteredPluginFindings } from '../../src/diagnostics/wiring.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { gatherFacts } from '../../src/agents/facts.ts';
import { renderBrief } from '../../src/agents/render.ts';
import { BRIEF_BEGIN } from '../../src/agents/brief-file.ts';
import { planNodeDevtool } from '../../src/devtool/npm-manifest.ts';
import { FRAMEWORK_RANGE } from '../../src/templates/framework-specifier.ts';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { agentFacts } from '../fixtures/agent-facts.ts';
import { options } from './schematics/_shared.ts';

const names = deriveNames('order-created');
const text = (files: readonly { path: string; contents: string }[], path: string): string => {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`Missing ${path}`);
  return file.contents;
};
function harness() {
  const fs = createFakeFs();
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (args: readonly string[], cwd = '/work') =>
      runCli(args, {
        fs,
        cwd,
        log: out.sink,
        error: err.sink,
        now: () => 0,
        secret: () => 's'.repeat(64),
        portAvailable: () => Promise.resolve(true),
      }),
  };
}

describe('M140d approved output', () => {
  it('§3.1 registers validation on minimal and diagnoses its missing registration', async () => {
    expect(ZERO_CONFIG_WIRINGS.get('validation-plugin')).toEqual({ symbol: 'ValidationPlugin' });
    const installed = new Set(['validation-plugin']);
    expect(unregisteredPluginFindings('', installed)).toEqual([
      { kind: 'plugin-unregistered', pkg: 'validation-plugin', symbol: 'ValidationPlugin' },
    ]);
    expect(
      unregisteredPluginFindings(
        "import { createRestApp } from '@setu-ts/rest-starter'; createRestApp({});",
        installed,
      ),
    ).toEqual([]);
    const h = harness();
    expect(await h.run(['new', 'api'])).toBe(0);
    expect(await h.run(['add', 'validation'], '/work/api'), h.err.text()).toBe(0);
    expect(h.fs.read('/work/api/setu.config.ts')).toContain('ValidationPlugin()');
  });

  it('§3.2 refuses populated bodies until schema fields exist and prints both bindings', async () => {
    const contents = generateSchema(names, options(['validation-plugin']))[0]!.contents;
    expect(contents).toContain('z.strictObject({})');
    expect(contents).toContain('body.value(ctx)');
    expect(contents).toContain('@ValidateBody(OrderCreated)');
    // Execute the emitted expression with the same Zod version as a generated project.
    const source = ts.transpileModule(contents.replace("import { z } from 'zod';", ''), {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText;
    const loaded: { OrderCreated: z.ZodType } = await import(
      `data:text/javascript,${encodeURIComponent("import { z } from '" + import.meta.resolve('zod') + "';\n" + source)}`
    );
    expect(loaded.OrderCreated.safeParse({ field: 'refused' }).success).toBe(false);
    for (const template of ['rest', 'class-based']) {
      const h = harness();
      expect(await h.run(['new', 'api', '--template', template])).toBe(0);
      expect(await h.run(['g', 'schema', 'order-created'], '/work/api'), h.err.text()).toBe(0);
      expect(h.out.text()).toContain('Bind src/shared/schemas/order-created.schemas.ts:');
      expect(h.out.text()).toContain(
        template === 'rest'
          ? 'const body = validateBody(OrderCreated)'
          : '@ValidateBody(OrderCreated)',
      );
    }
  });

  it('§3.3 names every real Redis provider and its offline replacement', async () => {
    for (const [pkg, factory, flag] of [
      ['cache', CachePlugin, '--store'],
      ['queue', QueuePlugin, '--queue'],
      ['messaging', MessagingPlugin, '--broker'],
      ['scheduler', SchedulerPlugin, '--lock'],
      // Not a cli devDependency: its default name is pinned from the source
      // (`idempotency-plugin/src/plugin/idempotency-plugin.ts`, `name: 'idempotency-plugin'`).
      ['idempotency', undefined, '--store'],
      ['realtime-backplane', RealtimeBackplanePlugin, '--backplane'],
    ] as const) {
      const h = harness();
      expect(await h.run(['new', 'api', '--template', 'rest'])).toBe(0);
      expect(await h.run(['add', pkg, flag, 'redis'], '/work/api'), h.err.text()).toBe(0);
      if (factory !== undefined) expect(factory().name).toBe(`${pkg}-plugin`);
      expect(h.out.text()).toContain(`without: ['${pkg}-plugin']`);
      expect(h.out.text()).toContain(
        `overrides: [${ZERO_CONFIG_WIRINGS.get(`${pkg}-plugin`)!.symbol}()]`,
      );
      expect(h.out.text()).toContain('connect to Redis at REDIS_URL during startup');
      expect(h.out.text()).toContain(
        'Start Redis: docker compose -f docker/compose.yaml up -d redis',
      );
      // The hint names a file this same run wrote.
      expect(await h.fs.readFile('/work/api/docker/compose.yaml')).toBeDefined();
    }
    for (const name of BROKERS) {
      const spec = brokerSpec(name)!;
      const [variable] = brokerEnvVariables(spec);
      if (variable === undefined) continue;
      // Every connection setting is named for what it is (a URL, a broker list, a
      // project id, a connection string), never described as a transport.
      expect(variable.description, name).toContain(
        `${variable.name} configures the ${spec.name} connection.`,
      );
      expect(variable.description, name).not.toContain('transport');
    }
  });

  it('§3.4 writes database URLs per dialect without replacing an existing value', async () => {
    for (const [type, dialect, url] of [
      ['drizzle', 'postgresql', 'postgresql://postgres:postgres@127.0.0.1:5432/app'],
      ['drizzle', 'sqlite', 'file:./local.db'],
      ['prisma', '', 'postgresql://postgres:postgres@127.0.0.1:5432/app'],
    ]) {
      const h = harness();
      expect(await h.run(['new', 'api'])).toBe(0);
      const args = [
        'add',
        'database',
        '--type',
        type!,
        ...(dialect === '' ? [] : ['--dialect', dialect!]),
      ];
      expect(await h.run(args, '/work/api'), h.err.text()).toBe(0);
      expect(h.fs.read('/work/api/.env')).toContain(`DATABASE_URL=${url}\n`);
      expect(h.fs.read('/work/api/.env.example')).toContain('DATABASE_URL=\n');
      await h.fs.writeFile('/work/api/.env', new TextEncoder().encode('DATABASE_URL=mine\n'));
      expect(await h.run(args, '/work/api')).toBe(0);
      expect(h.fs.read('/work/api/.env')).toBe('DATABASE_URL=mine\n');
    }
    const h = harness();
    expect(await h.run(['new', 'api', '--runtime', 'deno'])).toBe(0);
    expect(await h.run(['add', 'database', '--type', 'drizzle'], '/work/api'), h.err.text()).toBe(
      0,
    );
    expect(h.fs.has('/work/api/.env')).toBe(false);
    expect(h.out.text()).toContain(
      'Set DATABASE_URL (local default postgresql://postgres:postgres@127.0.0.1:5432/app) in the environment that runs db:generate/db:migrate.',
    );
  });

  it('§3.5 reports each independent development transport and survives Prettier', async () => {
    const section = getTemplate('microservice')!.manifest!.readmeSection;
    if (typeof section !== 'function') throw new Error('Missing development transport renderer');
    expect(section('setu', 'node')).toContain('Messaging is in-memory');
    for (const broker of [false, true])
      for (const queue of [false, true]) {
        let host = resolveHost(getTemplate('microservice')!, 'node');
        if (broker) host = withBrokerArgs(host, brokerSpec('redis')!, workspaceProfile('node'));
        if (queue) host = withQueueArgs(host, brokerSpec('redis')!, workspaceProfile('node'));
        const readme = text(projectFiles('api', 'node', host), 'README.md');
        expect(readme.includes('Messaging is in-memory')).toBe(!broker);
        expect(readme.includes('Queue is in-memory')).toBe(!queue);
        expect(readme).toContain('spans are dropped');
        expect(readme).toContain('Discovery is static and empty');
        expect(await format(readme, { ...PRETTIER_OPTIONS, parser: 'markdown' })).toBe(readme);
      }
  });

  it('§3.5 tells a workspace member where its transports come from, for both styles', async () => {
    // A member's options come from its CLI-owned transport module, so the call text
    // says nothing about the broker; the section must hold for every workspace broker.
    for (const template of [
      getTemplate('microservice')!,
      getTemplate('microservice')!.classBased!,
    ]) {
      const section = template.manifest!.readmeSection;
      if (typeof section !== 'function') throw new Error('Missing development transport renderer');
      const member = section('setu', 'node', true);
      const prose = member.replace(/\n\s+/g, ' ');
      expect(prose).toContain('`src/transport/index.ts`');
      expect(prose).toContain('With the `memory` broker, or a broker without a queue arm');
      expect(prose).toContain('`setu workspace broker <name>`');
      expect(member).not.toContain('Messaging is in-memory');
      expect(member).not.toContain('Discovery is static and empty');
      expect(await format(member, { ...PRETTIER_OPTIONS, parser: 'markdown' })).toBe(member);
    }
  });

  it('§3.6 renders truthful README guidance and a shutdown fallback', () => {
    const minimal = projectFiles('api', 'node', resolveHost(MINIMAL_HOST, 'node'));
    expect(text(minimal, 'main.ts')).toContain(
      'else console.error(`Graceful shutdown failed: ${describeError(error)}`)',
    );
    const rest = text(
      projectFiles('api', 'node', resolveHost(getTemplate('rest')!, 'node')),
      'README.md',
    );
    expect(rest).toContain('generate module billing');
    expect(rest).not.toContain('DI graph validation happens at boot');
    expect(rest).toContain('are served on the application port');
    expect(rest).toContain('swagger: false');
    const decorated = text(
      projectFiles('api', 'node', resolveHost(getTemplate('class-based')!, 'node')),
      'README.md',
    );
    expect(decorated).toContain('DI graph validation happens at boot');
  });

  it('§3.7 describes at-most-once delivery in both event arms and how jobs register', () => {
    for (const plugins of [[], ['decorator-plugin']]) {
      const event = generateEventHandler(names, options(plugins))[0]!.contents;
      expect(event).toContain('at-most-once');
      expect(event).toContain('not redelivered');
      expect(event).toContain('defineIntegrationEvent');
    }
    expect(generateJob(names, options())[0]!.contents).toContain(
      'Register these in `setu.config.ts`',
    );
  });

  it('§3.8 routes both event forms on PascalCase names', () => {
    for (const plugins of [[], ['decorator-plugin']])
      expect(generateEventHandler(names, options(plugins))[0]!.contents).toContain(
        "ORDER_CREATED_EVENT = 'OrderCreated'",
      );
  });

  it('§3.9 measures Server-Timing with the runtime monotonic clock', () => {
    const source = generateMiddleware(names, options())[0]!.contents;
    expect(source).toContain('ctx.services.get(CAPABILITIES.RUNTIME)');
    expect(source).toContain('runtime.hrtime() - ctx.startTime');
    expect(source).toContain("'Server-Timing', `order-created;dur=${ms.toFixed(1)}`");
  });

  it('§3.10 owns decorated module state per instance and removes dead validation fallbacks', () => {
    const source = moduleService(names, true, true);
    expect(source).toContain('private readonly records = new Map');
    expect(source).toContain('this.records.get(id)');
    expect(source).not.toContain('export function');
    expect(source).not.toContain('query.offset ??');
    expect(source).not.toContain('...current, ...body');
    expect(moduleService(names, false)).toContain('query.offset ?? 0');
  });

  it('§3.11 tells module consumers the provider is already registered', () => {
    const source = generateService(names, {
      ...options(['decorator-plugin']),
      targetModule: 'orders',
    })[0]!.contents;
    expect(source).toContain("Registered in orders.module.ts's providers");
    expect(source).toContain("@Inject('orders.order-created-service')");
    const showcase = text(
      projectFiles('api', 'node', resolveHost(getTemplate('class-based')!, 'node')),
      'src/controllers/greeting.controller.ts',
    );
    expect(showcase).toContain(
      'TC39 standard decorators carry no parameter type information on any runtime',
    );
  });

  it('§3.12 makes the optional devtool entry explicit in the config JSDoc', () => {
    expect(
      text(projectFiles('api', 'node', resolveHost(MINIMAL_HOST, 'node')), 'setu.config.ts'),
    ).toContain('written by `--devtool` or `setu devtool enable`');
  });

  it('§3.13 points login at a request-bound service and keeps nav/guard guidance current', () => {
    const files = projectFiles('api', 'node', resolveHost(getTemplate('full-stack')!, 'node'));
    expect(text(files, 'app/routes/_auth/login.tsx')).toContain('getService(context, <TOKEN>)');
    expect(text(files, 'app/lib/nav-utils.ts')).toContain('add an entry for each signed-in page');
    expect(text(files, 'app/server/require-user.server.ts')).toContain('each guarded');
  });

  it('§3.13 prints the exact APP_NAV entry after writing a module page', async () => {
    const h = harness();
    expect(await h.run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
    expect(await h.run(['g', 'module', 'orders', '--page'], '/work/shop'), h.err.text()).toBe(0);
    expect(h.out.text()).toContain(
      "Add { to: '/orders', label: 'Orders' } to APP_NAV in app/lib/nav-utils.ts to link the page.",
    );
  });

  it('§3.14 uses exception factories and a service-only unit test, omitted on Workers', () => {
    const files = generateFullStackModule(names, { runtime: 'node' });
    const controller = text(files, 'src/modules/order-created/order-created.controller.ts');
    expect(controller).toContain("import { badRequest, notFound } from '@setu-ts/exceptions'");
    expect(controller).toContain("throw badRequest('A non-empty name is required.')");
    expect(controller).toContain("throw notFound('OrderCreated not found.')");
    const unit = text(files, 'src/modules/order-created/order-created.test.ts');
    expect(unit).toContain('orderCreatedService(createTestContext())');
    expect(unit).not.toContain('startTestServer');
    const workers = generateFullStackModule(names, { runtime: 'cloudflare-workers' });
    expect(workers.some((file) => file.path.endsWith('/order-created.test.ts'))).toBe(false);
    expect(workers.some((file) => file.path.endsWith('.e2e.test.ts'))).toBe(true);
  });

  it('§3.15 installs React only as a runtime dependency', () => {
    const files = projectFiles('api', 'node', resolveHost(getTemplate('full-stack')!, 'node'));
    const manifest = JSON.parse(text(files, 'package.json'));
    for (const pkg of ['react', 'react-dom', 'react-router']) {
      expect(manifest.dependencies[pkg]).toBeDefined();
      expect(manifest.devDependencies[pkg]).toBeUndefined();
    }
  });

  it('§3.16 accepts generate --yes and -y without changing its writes', async () => {
    for (const verb of [undefined, 'custom', 'app', 'library']) {
      const spec = commandFlagsFor('generate', verb)!;
      expect(spec.documented).toContain('yes');
      expect(spec.documented).toContain('y');
    }
    for (const flag of ['--yes', '-y']) {
      const h = harness();
      expect(await h.run(['new', 'api'])).toBe(0);
      expect(await h.run(['g', 'service', 'billing', flag], '/work/api'), h.err.text()).toBe(0);
      expect(h.fs.read('/work/api/src/services/billing.service.ts')).toContain('describeBilling');
    }
  });

  it('§3.17 reports an unreadable brief without failing a successful generation', async () => {
    const h = harness();
    expect(await h.run(['new', 'api'])).toBe(0);
    await h.fs.writeFile('/work/api/AGENTS.md', new TextEncoder().encode(BRIEF_BEGIN));
    const read = h.fs.readFile;
    h.fs.readFile = (path) =>
      path.endsWith('/AGENTS.md') ? Promise.reject(new Error('blocked')) : read(path);
    expect(await h.run(['g', 'service', 'billing'], '/work/api')).toBe(0);
    expect(h.err.text()).toContain('Cannot inspect AGENTS.md:');
    expect(h.err.text()).toContain('blocked');
  });

  it('§3.17 reminds brief owners after generate, sync and devtool writes', async () => {
    for (const marker of ['', BRIEF_BEGIN]) {
      for (const command of [['g', 'service', 'billing'], ['sync'], ['devtool', 'enable']]) {
        const h = harness();
        expect(await h.run(['new', 'api'])).toBe(0);
        await h.fs.writeFile('/work/api/AGENTS.md', new TextEncoder().encode(marker));
        if (command[0] === 'sync') {
          // Give sync a stale barrel to rewrite: a sync that changes nothing stays quiet.
          expect(await h.run(['g', 'middleware', 'timing'], '/work/api')).toBe(0);
          await h.fs.writeFile(
            '/work/api/src/middleware/index.ts',
            new TextEncoder().encode('export {};\n'),
          );
        }
        const before = h.out.lines.length;
        expect(await h.run(command, '/work/api'), h.err.text()).toBe(0);
        expect(h.out.lines.slice(before).join('\n').includes('agents --check')).toBe(marker !== '');
        if (command[0] === 'sync') {
          const again = h.out.lines.length;
          expect(await h.run(['sync'], '/work/api')).toBe(0);
          expect(h.out.lines.slice(again).join('\n')).not.toContain('agents --check');
        }
      }
    }
  });

  it('§3.18 gathers devtool facts and gates validation/start guidance by project facts', async () => {
    const h = harness();
    expect(await h.run(['new', 'api', '--devtool'])).toBe(0);
    const facts = await gatherFacts(h.fs, '/work/api');
    expect(facts.devtool).toBe(true);
    const brief = renderBrief(facts);
    expect(brief).toContain('SETU_DEVTOOL_SESSION_ID');
    expect(brief).toContain('SETU_DEVTOOL_SESSION_KEY');
    expect(brief).toContain('CLI-managed allowlist');
    expect(brief).toContain('launcher credentials required');
    expect(brief).not.toContain('validateBody(');
    expect(renderBrief(agentFacts({ installed: new Set(['validation-plugin']) }))).toContain(
      'validateBody(S)',
    );
    expect(renderBrief(agentFacts({ runtime: 'deno', commands: ['start', 'build'] }))).toContain(
      'production entry; run build first',
    );
  });

  it('§3.17 reminds workspace brief owners after app and library writes, never dry runs', async () => {
    for (const marker of ['', BRIEF_BEGIN])
      for (const dry of [false, true]) {
        for (const verb of ['app', 'library']) {
          const h = harness();
          expect(await h.run(['new', 'ws', '--workspace'])).toBe(0);
          await h.fs.writeFile('/work/ws/AGENTS.md', new TextEncoder().encode(marker));
          const before = h.out.lines.length;
          expect(
            await h.run(['g', verb, 'orders', ...(dry ? ['--dry-run'] : [])], '/work/ws'),
            h.err.text(),
          ).toBe(0);
          expect(h.out.lines.slice(before).join('\n').includes('agents --check')).toBe(
            marker !== '' && !dry,
          );
        }
      }
  });

  it('§3.17 reminds workspace devtool owners once when either brief carries the marker', async () => {
    for (const root of [false, true])
      for (const member of [false, true]) {
        const h = harness();
        expect(await h.run(['new', 'ws', '--workspace'])).toBe(0);
        expect(await h.run(['g', 'app', 'orders'], '/work/ws')).toBe(0);
        if (root) await h.fs.writeFile('/work/ws/AGENTS.md', new TextEncoder().encode(BRIEF_BEGIN));
        if (member)
          await h.fs.writeFile(
            '/work/ws/apps/orders/AGENTS.md',
            new TextEncoder().encode(BRIEF_BEGIN),
          );
        const before = h.out.lines.length;
        expect(await h.run(['devtool', 'enable', 'orders'], '/work/ws'), h.err.text()).toBe(0);
        const hints = h.out.lines.slice(before).filter((line) => line.includes('agents --check'));
        expect(hints).toHaveLength(root || member ? 1 : 0);
      }
  });

  it('§3.19 loads the env file and instrumentation before the Node devtool entry', () => {
    const plan = planNodeDevtool(
      JSON.stringify({
        devDependencies: { tsx: '^4', '@setu-ts/diagnostics-plugin': FRAMEWORK_RANGE },
      }),
      'package.json',
      '--env-file-if-exists=local.env ',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.message);
    expect(JSON.parse(plan.contents!).scripts.dev).toBe(
      'tsx --import ./instrumentation.mjs --env-file-if-exists=local.env main.dev.ts',
    );
  });

  it('§3.19 refuses the old dev script and uses custom env declarations in both quote styles', async () => {
    expect(
      planNodeDevtool(
        JSON.stringify({ devDependencies: { tsx: '^4' }, scripts: { dev: 'tsx main.dev.ts' } }),
      ).ok,
    ).toBe(false);
    for (const quote of ["'", '"']) {
      const h = harness();
      expect(await h.run(['new', 'api', '--template', 'rest', '--env-file', 'local.env'])).toBe(0);
      const config = h.fs
        .read('/work/api/setu.config.ts')
        .replace("envFilePath: 'local.env'", `envFilePath: ${quote}local.env${quote}`);
      await h.fs.writeFile('/work/api/setu.config.ts', new TextEncoder().encode(config));
      expect(await h.run(['devtool', 'enable'], '/work/api'), h.err.text()).toBe(0);
      const manifest = JSON.parse(h.fs.read('/work/api/package.json'));
      expect(manifest.scripts.dev).toBe(
        'tsx --import ./instrumentation.mjs --env-file-if-exists=local.env main.dev.ts',
      );
    }
    const h = harness();
    expect(
      await h.run(['new', 'api', '--template', 'rest', '--env-file', 'local.env', '--devtool']),
    ).toBe(0);
    expect(JSON.parse(h.fs.read('/work/api/package.json')).scripts.dev).toBe(
      'tsx --import ./instrumentation.mjs --env-file-if-exists=local.env main.dev.ts',
    );
    const layered = harness();
    expect(await layered.run(['new', 'api', '--template', 'rest'])).toBe(0);
    await layered.fs.writeFile(
      '/work/api/setu.config.ts',
      new TextEncoder().encode(
        layered.fs
          .read('/work/api/setu.config.ts')
          .replace("envFilePath: '.env'", "envFilePath: ['local.env', '.env']"),
      ),
    );
    expect(await layered.run(['devtool', 'enable'], '/work/api'), layered.err.text()).toBe(0);
    expect(JSON.parse(layered.fs.read('/work/api/package.json')).scripts.dev).toBe(
      'tsx --import ./instrumentation.mjs --env-file-if-exists=.env --env-file-if-exists=local.env main.dev.ts',
    );
  });
});

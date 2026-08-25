import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { listTemplates } from '../../src/templates/registry.ts';
import type { PortProbe } from '../../src/workspace/port-probe.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}, portAvailable?: PortProbe): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runNewCommand(parseArgs(argv), {
        fs,
        cwd: '/work',
        log: out.sink,
        error: err.sink,
        ...(portAvailable === undefined ? {} : { portAvailable }),
      }),
  };
}

// The guard itself is unit-tested in `file-writer.test.ts`, where it lives.
// This is the invariant it protects, driven through the real command.
describe('the duplicate-path guard', () => {
  it('reports no duplicate for any built-in template on any runtime', async () => {
    // The invariant the guard protects: a template's own files must never
    // collide with the fixed project files, for any target.
    for (const template of listTemplates()) {
      for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
        const h = harness();
        const code = await h.run(['app', '--template', template.name, '--runtime', runtime]);
        expect(code).toBe(0);
        expect(h.err.lines.join('\n')).not.toContain('twice');
      }
    }
  });
});

// Node's built-in TypeScript support ERASES types without transforming code, so
// `node --experimental-strip-types main.ts` — what this CLI emitted through
// alpha.5 — cannot run a legacy decorator or a constructor parameter property.
// Measured on Node v24: a scaffolded Node project booted until the first
// `g service|controller|module`, and the old class template never booted at all,
// while Deno, Bun and Workers ran every combination.
// `wrangler` bundles `src/index.ts` with esbuild, which resolves neither `jsr:`
// specifiers nor a Deno import map. Before this, a scaffolded Workers project
// declared its framework packages only in `deno.json`, so the documented
// `npm install && npx wrangler dev` failed with one
// `Could not resolve "@setu-ts/…"` per package — eleven of them — even though
// the CLI's own next-step hint already told you to run npm install. Verified
// against real workerd both ways.
describe('the Workers target is deployable as documented', () => {
  const workers = async (template?: string) => {
    const h = harness();
    const argv = ['app', '--runtime', 'cloudflare-workers'];
    if (template !== undefined) argv.push('--template', template);
    expect(await h.run(argv)).toBe(0);
    return h;
  };

  it('emits an npm manifest esbuild can resolve the framework through', async () => {
    const h = await workers('rest');
    const manifest = JSON.parse(h.fs.read('/work/app/package.json')) as {
      dependencies?: Record<string, string>;
    };
    // Every package the generated config imports must be installable.
    const config = h.fs.read('/work/app/setu.config.ts');
    for (const match of config.matchAll(/from '(@setu-ts\/[a-z-]+)'/g)) {
      expect(Object.keys(manifest.dependencies ?? {})).toContain(match[1]);
    }
  });

  it('maps the @jsr scope, without which those packages do not install', async () => {
    const h = await workers('rest');
    expect(h.fs.read('/work/app/.npmrc')).toContain('@jsr:registry=https://npm.jsr.io');
  });

  it('pins wrangler rather than leaving npx to fetch whatever is latest', async () => {
    const h = await workers('rest');
    const manifest = JSON.parse(h.fs.read('/work/app/package.json')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['wrangler']).toBeDefined();
    expect(manifest.scripts?.['dev']).toBe('wrangler dev');
    expect(manifest.scripts?.['deploy']).toBe('wrangler deploy');
  });

  it('keeps its deno.json too, which is what generate reads for plugin gating', async () => {
    const h = await workers('rest');
    expect(h.fs.has('/work/app/deno.json')).toBe(true);
  });

  // The trap this must not reintroduce: a package.json switches Deno to
  // node_modules resolution, which is the `apps/full-stack` cold-checkout
  // failure. Only Workers gets one for this reason.
  it('gives a plain Deno project no package.json', async () => {
    const h = harness();
    expect(await h.run(['app', '--runtime', 'deno', '--template', 'rest'])).toBe(0);
    expect(h.fs.has('/work/app/package.json')).toBe(false);
    expect(h.fs.has('/work/app/.npmrc')).toBe(false);
  });

  it('merges a template npm build into the same manifest, not a second one', async () => {
    const h = await workers('full-stack');
    const manifest = JSON.parse(h.fs.read('/work/app/package.json')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.scripts?.['build']).toBe('react-router build');
    expect(manifest.scripts?.['deploy']).toBe('wrangler deploy');
    expect(manifest.devDependencies?.['wrangler']).toBeDefined();
    expect(manifest.devDependencies?.['vite']).toBeDefined();
    expect(manifest.dependencies?.['@setu-ts/common']).toBeDefined();
  });
});

describe('the Node target can run decorated source', () => {
  const manifestOf = async (runtime: string, template?: string) => {
    const h = harness();
    const argv = ['app', '--runtime', runtime];
    if (template !== undefined) argv.push('--template', template);
    expect(await h.run(argv)).toBe(0);
    return JSON.parse(h.fs.read('/work/app/package.json')) as {
      scripts: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  };

  it('runs Node through a transpiler, not through type stripping', async () => {
    const manifest = await manifestOf('node');
    expect(manifest.scripts['start']).toBe('tsx main.ts');
    expect(manifest.scripts['start']).not.toContain('experimental-strip-types');
    expect(manifest.scripts['start']).not.toContain('experimental-transform-types');
  });

  it('declares the transpiler it invokes', async () => {
    // Derived from the emitted script rather than hardcoding `tsx`, so this
    // still holds if the runner is ever swapped: a start script naming a binary
    // the manifest does not install is a project that reports success and then
    // cannot run. CI never boots a Node-target project, so this invariant is
    // the standing guard for that.
    const manifest = await manifestOf('node');
    const binary = manifest.scripts['start']?.split(' ')[0];
    expect(binary).toBeDefined();
    expect(binary).not.toBe('node');
    expect(Object.keys(manifest.devDependencies ?? {})).toContain(binary);
  });

  it('gives no other target the Node transpiler', async () => {
    // Bun compiles TypeScript outright; Deno and Workers never invoke it.
    const bun = await manifestOf('bun');
    expect(bun.scripts['start']).toBe('bun run main.ts');
    expect(bun.devDependencies?.['tsx']).toBeUndefined();
  });

  it('keeps a template own devDependencies alongside it', async () => {
    // The merge must not replace the template's block — full-stack pins a whole
    // frontend toolchain there.
    const manifest = await manifestOf('node', 'full-stack');
    expect(manifest.devDependencies?.['tsx']).toBeDefined();
    expect(manifest.devDependencies?.['vite']).toBeDefined();
  });

  // This used to assert the OPPOSITE — that the Bun + no-template combination
  // emitted no `devDependencies` at all, because it was the one path
  // contributing neither a runtime nor a template entry. It no longer exists:
  // the entry's shutdown listener registers on `process`, whose declarations a
  // Bun project has to declare, so every project on this branch now carries the
  // block and the empty-object guard it was testing is gone.
  it('declares the Bun type declarations even with no template', async () => {
    const h = harness();
    expect(await h.run(['app', '--runtime', 'bun'])).toBe(0);
    const manifest = JSON.parse(h.fs.read('/work/app/package.json')) as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.['@types/bun']).toBeDefined();
    // Not `@types/node`: a Bun project declares the package Bun's own docs
    // prescribe, which supplies the same `process` declarations transitively.
    expect(manifest.devDependencies?.['@types/node']).toBeUndefined();
    expect(manifest.devDependencies?.['tsx']).toBeUndefined();
  });
});

describe('runNewCommand', () => {
  it('creates a deno project under the working directory by default', async () => {
    const h = harness();
    expect(await h.run(['my-app'])).toBe(0);
    for (const file of ['deno.json', 'main.ts', 'setu.config.ts', 'README.md', '.gitignore']) {
      expect(h.fs.has(`/work/my-app/${file}`)).toBe(true);
    }
  });

  describe('the setu.config.ts seam', () => {
    it('is emitted even without --template', async () => {
      // Plugin-command discovery needs one seam that always exists.
      const h = harness();
      await h.run(['app']);
      expect(h.fs.read('/work/app/setu.config.ts')).toContain('export function createApp()');
    });

    it('carries only the runtime plugin without --template', async () => {
      const h = harness();
      await h.run(['app']);
      const config = h.fs.read('/work/app/setu.config.ts');
      expect(config).toContain('RuntimePlugin()');
      expect(config).not.toContain('ConfigPlugin');
      expect(config).not.toContain('errorHandler');
    });

    it('does not start the application — main.ts owns that', async () => {
      // Importing this module must never bind a socket.
      const h = harness();
      await h.run(['app']);
      expect(h.fs.read('/work/app/setu.config.ts')).not.toContain('.start(');
    });

    it('is the only place main.ts gets its plugin list from', async () => {
      const h = harness();
      await h.run(['app']);
      const main = h.fs.read('/work/app/main.ts');
      expect(main).toContain("import { createApp } from './setu.config.ts'");
      expect(main).toContain("app.start({ port: Number(runtime.env.PORT ?? '3000') })");
      expect(main).not.toContain('RuntimePlugin');
      expect(main).not.toContain('createApplication');
    });
  });

  describe('a template that composes through a starter factory', () => {
    it('awaits the factory instead of calling createApplication', async () => {
      const h = harness();
      expect(await h.run(['shop', '--template', 'full-stack'])).toBe(0);
      const config = h.fs.read('/work/shop/setu.config.ts');

      expect(config).toContain('await createFullStackAppFromConfig(');
      expect(config).toContain("from '@setu-ts/full-stack-starter'");
      // The kernel is not on this path at all.
      expect(config).not.toContain('createApplication');
      expect(config).not.toContain('@setu-ts/kernel');
    });

    it('exports an async factory, which the loader already awaits', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const config = h.fs.read('/work/shop/setu.config.ts');

      expect(config).toContain('export async function createApp(');
      expect(config).toContain('): Promise<IApplication> {');
      // Still must not start the server: command discovery imports this module.
      expect(config).not.toContain('.start(');
    });

    it('pins the starter in the manifest and drops the kernel', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const manifest = JSON.parse(h.fs.read('/work/shop/deno.json'));

      expect(manifest.imports['@setu-ts/full-stack-starter']).toContain(
        'jsr:@setu-ts/full-stack-starter@',
      );
      // Declaring the kernel would name a package the project never imports.
      expect(manifest.imports['@setu-ts/kernel']).toBeUndefined();
      // Still needed: the config module imports the IApplication type.
      expect(manifest.imports['@setu-ts/common']).toBeDefined();
    });

    it('declares every package the generated config imports', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const config = h.fs.read('/work/shop/setu.config.ts');
      const manifest = JSON.parse(h.fs.read('/work/shop/deno.json'));

      for (const match of config.matchAll(/from '(@setu-ts\/[a-z-]+)'/g)) {
        expect(Object.keys(manifest.imports)).toContain(match[1]);
      }
    });

    it('emits the app tree alongside the config', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);

      for (
        const file of [
          'app/routes.ts',
          'app/root.tsx',
          'app/lib/context-keys.server.ts',
          'app/lib/load-context.ts',
          'app/features/products/products.server.ts',
          'vite.config.ts',
          'react-router.config.ts',
        ]
      ) {
        expect(h.fs.has(`/work/shop/${file}`)).toBe(true);
      }
    });

    it('threads the Workers env binding into the factory', async () => {
      // On Workers the environment is per-request, so a factory that resolves
      // configuration before any plugin is constructed can only see it if the
      // entry hands it over. Without this the app composes from an empty
      // config and fails on every request, since `booted` memoises the boot.
      const h = harness();
      expect(
        await h.run(['shop', '--template', 'full-stack', '--runtime', 'cloudflare-workers']),
      ).toBe(0);

      const entry = h.fs.read('/work/shop/src/index.ts');
      const config = h.fs.read('/work/shop/setu.config.ts');

      expect(entry).toContain('async fetch(request: Request, env: Record<string, unknown>)');
      expect(entry).toContain('await ensureBooted(env)');
      expect(entry).toContain('createApp(env)');
      expect(config).toContain('env?: Readonly<Record<string, unknown>>');
      expect(config).toContain('{ env }');
      expect(config).not.toContain('envFilePath');
      expect(h.fs.has('/work/shop/.env')).toBe(false);
      expect(h.fs.has('/work/shop/.env.example')).toBe(false);
    });

    it('uses Workers bindings instead of a requested dotenv file', async () => {
      const h = harness();

      expect(
        await h.run([
          'api',
          '--template',
          'rest',
          '--runtime',
          'cloudflare-workers',
          '--env-file',
          '.env.local',
        ]),
      ).toBe(2);
      expect(h.err.text()).toContain('unavailable on Cloudflare Workers');
      expect(h.fs.writes).toEqual([]);
    });

    it('omits filesystem dotenv configuration from a Workers REST scaffold', async () => {
      const h = harness();
      expect(await h.run(['api', '--template', 'rest', '--runtime', 'cloudflare-workers'])).toBe(0);

      const config = h.fs.read('/work/api/setu.config.ts');
      expect(config).toContain('ConfigPlugin()');
      expect(config).not.toContain('envFilePath');
      expect(h.fs.has('/work/api/.env')).toBe(false);
    });

    it('threads env through the Workers entry for a template without a factory too', async () => {
      // Not only the factory path needs it: with no ambient environment on the
      // edge, an inline-wiring app whose RuntimePlugin never receives `env`
      // registers runtime services whose `env` is empty, so ConfigPlugin and
      // the secrets EnvProvider read nothing.
      const h = harness();
      await h.run(['api', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/api/src/index.ts');
      const config = h.fs.read('/work/api/setu.config.ts');

      expect(entry).toContain('async fetch(request: Request, env: Record<string, unknown>)');
      expect(entry).toContain('await ensureBooted(env);');
      expect(entry).toContain('createApp(env)');
      expect(config).toContain('export function createApp(env: Readonly<Record<string, unknown>>');
      expect(config).toContain('RuntimePlugin({ env })');
    });

    it('leaves templates without a factory rendering exactly as before', async () => {
      // The field is additive: the rest template must be untouched by it.
      const h = harness();
      await h.run(['api', '--template', 'rest']);
      const config = h.fs.read('/work/api/setu.config.ts');

      expect(config).toContain('export function createApp(): IApplication');
      expect(config).toContain('createApplication({');
      expect(config).toContain("app.router.get('/'");
      expect(config).not.toContain('await create');
    });
  });

  describe('--template', () => {
    it('emits an ignored dotenv file, a tracked example, and one matching ConfigPlugin path', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest', '--env-file', '.env.local'])).toBe(0);

      expect(h.fs.read('/work/app/.env.local')).toContain('Local configuration');
      expect(h.fs.read('/work/app/.env.local.example')).toContain('Copy this file');
      expect(h.fs.read('/work/app/.gitignore')).toContain('.env.local');
      // `envFileOptional` rides along, and is the reason this project starts on
      // a machine that never ran `setu new` — the emitted file is gitignored.
      expect(h.fs.read('/work/app/setu.config.ts')).toContain(
        "ConfigPlugin({ envFilePath: '.env.local', envFileOptional: true })",
      );
    });

    it('refuses an env file for a template without ConfigPlugin', async () => {
      const h = harness();
      expect(await h.run(['app', '--env-file', '.env'])).toBe(2);
      expect(h.err.text()).toContain('requires a template that registers ConfigPlugin');
      expect(h.fs.writes).toEqual([]);
    });

    it('names the variables its own generated source reads', async () => {
      // full-stack emits `config.getOrThrow<string>('SESSION_SECRET')`, so a
      // dotenv pair naming nothing left the one template that REQUIRES a value
      // unable to start, and its committed example a blank file — which is the
      // question the dotenv deliverable exists to answer.
      const h = harness();
      expect(await h.run(['app', '--template', 'full-stack'])).toBe(0);

      const env = h.fs.read('/work/app/.env');
      const example = h.fs.read('/work/app/.env.example');
      expect(env).toContain('SESSION_SECRET=');
      expect(example).toContain('SESSION_SECRET=');
      // The gitignored file carries a working development value; the COMMITTED
      // example carries none, so nothing here can be deployed by accident.
      expect(env).toContain('SESSION_SECRET=dev-only-insecure-session-secret-change-me');
      expect(example).toContain('SESSION_SECRET=\n');
    });

    it('refuses --depends-on, which only a workspace member can honour', async () => {
      // Every other misapplied flag is refused — `--port`, `--transport`,
      // `--env-file` on a root — and this one was silently accepted, so a
      // standalone project scaffolded successfully while the ordering the
      // developer asked for was read by nothing at all.
      const h = harness();
      expect(await h.run(['app', '--template', 'rest', '--depends-on', 'orders'])).toBe(2);
      expect(h.err.text()).toContain('generate app');
      expect(h.fs.writes).toEqual([]);
    });

    it('writes the rest plugin set into setu.config.ts', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      const config = h.fs.read('/work/app/setu.config.ts');
      for (
        const symbol of [
          'RuntimePlugin',
          'LoggerPlugin',
          'ValidationPlugin',
          'HttpSecurityPlugin',
          'OpenApiPlugin',
        ]
      ) {
        if (symbol !== 'ValidationPlugin') {
          expect(config).toContain(`${symbol}()`);
        }
      }
      // M70f (C3): validation answers in the same Problem Details shape the
      // `errorHandler` emits for thrown errors, so it is NOT argument-free.
      expect(config).toContain("ValidationPlugin({ errorFormat: 'rfc9457' })");
      expect(config).toContain("ConfigPlugin({ envFilePath: '.env', envFileOptional: true })");
      // Three plugins take a generated-artifact seam, so they are NOT argument-free.
      // Asserted by their actual call so a dropped seam shows up here rather than only
      // in the drift gate.
      expect(config).toContain('HealthPlugin({ indicators: [...HEALTH_INDICATORS] })');
      expect(config).toContain('MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })');
      expect(config).not.toContain('DecoratorPlugin');
    });

    it('renders the plugin list, middleware, setup calls, then the index route', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      const config = h.fs.read('/work/app/setu.config.ts');

      const order = [
        'createApplication({',
        "app.middleware.add(errorHandler({ format: 'rfc9457' })",
        'registerGeneratedRoutes(app.router);',
        'for (const generated of GENERATED_MIDDLEWARE) {',
        "app.router.get('/'",
      ].map((needle) => config.indexOf(needle));

      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('spreads the generated plugins into the plugin array', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      expect(h.fs.read('/work/app/setu.config.ts')).toContain('...GENERATED_PLUGINS,');
    });

    // M61 reverses M60's decision here, deliberately. A template-less project is
    // the one shape with no decorators and no DI container, so `setu g route` is
    // the only HTTP handler it can generate — and it used to land UNWIRED, which
    // made "no feature requires decorators" true only after a hand edit.
    it('wires the three ungated seams into a template-less project', async () => {
      const h = harness();
      expect(await h.run(['bare'])).toBe(0);
      const config = h.fs.read('/work/bare/setu.config.ts');
      expect(config).toContain('RuntimePlugin(),');
      // route: a call; plugin: an array spread; middleware: a loop.
      expect(config).toContain('registerGeneratedRoutes(app.router);');
      expect(config).toContain('...GENERATED_PLUGINS,');
      expect(config).toContain('for (const generated of GENERATED_MIDDLEWARE) {');
      // The barrels those imports name are emitted at scaffold time, so the
      // config never imports a module the project does not have.
      expect(h.fs.read('/work/bare/src/controllers/index.ts')).toContain('registerGeneratedRoutes');
      expect(h.fs.read('/work/bare/src/middleware/index.ts')).toContain('GENERATED_MIDDLEWARE');
      expect(h.fs.read('/work/bare/src/plugins/index.ts')).toContain('GENERATED_PLUGINS');
    });

    // The other half of the same rule: a seam whose plugin this host does not
    // register is omitted entirely, or the generated config would import a
    // barrel naming symbols from a package the project never installed.
    it('gives a template-less project no seam that needs a plugin', async () => {
      const h = harness();
      expect(await h.run(['bare'])).toBe(0);
      const config = h.fs.read('/work/bare/setu.config.ts');
      for (
        const absent of [
          'APP_CONTROLLERS',
          'APP_SERVICES',
          'HEALTH_INDICATORS',
          'CUSTOM_METRICS',
          'COMMAND_HANDLERS',
          'EVENT_HANDLERS',
          'MODULE_CONTROLLERS',
        ]
      ) {
        expect(config).not.toContain(absent);
      }
      // The HTTP barrel IS emitted — `controller` is ungated since E8, so a
      // bare project has one directory that answers requests. What it must not
      // carry is the CLASS-shaped registration: no APP_CONTROLLERS above, and
      // no import of `@setu-ts/decorator-plugin` anywhere.
      expect(h.fs.has('/work/bare/src/controllers/index.ts')).toBe(true);
      expect(h.fs.read('/work/bare/src/controllers/index.ts'))
        .toContain('export function registerGeneratedRoutes');
      expect(config).not.toContain('decorator-plugin');
      expect(h.fs.has('/work/bare/src/cqrs/index.ts')).toBe(false);
    });

    it('refuses the retired independent DI switch', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest', '--di'])).toBe(2);
      expect(h.err.text()).toContain('--template class-based');
      expect(h.fs.writes).toEqual([]);
    });

    it('adds errorHandler through middleware.add, not the plugin list', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const config = h.fs.read('/work/app/setu.config.ts');
      expect(config).toContain("import { errorHandler } from '@setu-ts/exceptions';");
      expect(config).not.toContain('ExceptionsPlugin');
    });

    it('registers errorHandler at priority 0, the outermost position', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const config = h.fs.read('/work/app/setu.config.ts');

      // `errorHandler`'s contract requires the outermost slot. A bare `add()`
      // takes the pipeline default of 500, which sits INSIDE the metrics
      // middleware at 20 — so a throw there escapes the try/catch entirely and
      // the project answers with a bare adapter 500, no RFC 7807 body, no log.
      expect(config).toContain(
        "app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });",
      );
      expect(config).not.toContain('app.middleware.add(errorHandler());');
    });

    it('registers errorHandler at priority 0 for the microservice template too', async () => {
      const h = harness();
      await h.run(['app', '--template', 'microservice']);
      const config = h.fs.read('/work/app/setu.config.ts');

      // The microservice set adds telemetry middleware at 30, so the same
      // ordering requirement applies — and it composes REST_MIDDLEWARE, so this
      // guards that the shared list keeps carrying its position.
      expect(config).toContain(
        "app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });",
      );
    });

    it('declares a manifest import for every package the config references', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const manifest = JSON.parse(h.fs.read('/work/app/deno.json'));
      const config = h.fs.read('/work/app/setu.config.ts');
      for (const specifier of Object.keys(manifest.imports)) {
        expect(typeof manifest.imports[specifier]).toBe('string');
      }
      // Every import in the generated source must be declared in the manifest.
      for (const match of config.matchAll(/from '(@setu-ts\/[a-z-]+)'/g)) {
        expect(Object.keys(manifest.imports)).toContain(match[1]);
      }
    });

    it('makes microservice a superset of rest in the emitted config', async () => {
      const rest = harness();
      await rest.run(['app', '--template', 'rest']);
      const micro = harness();
      await micro.run(['app', '--template', 'microservice']);
      const microConfig = micro.fs.read('/work/app/setu.config.ts');
      for (const symbol of ['ConfigPlugin', 'OpenApiPlugin', 'errorHandler']) {
        expect(microConfig).toContain(symbol);
      }
      for (
        const symbol of ['MessagingPlugin', 'QueuePlugin', 'ResiliencePlugin', 'TelemetryPlugin']
      ) {
        expect(microConfig).toContain(`${symbol}()`);
        expect(rest.fs.read('/work/app/setu.config.ts')).not.toContain(symbol);
      }
    });

    it('never emits a starter import', async () => {
      for (const template of ['rest', 'microservice']) {
        const h = harness();
        await h.run(['app', '--template', template]);
        for (const path of h.fs.writes) {
          expect(h.fs.read(path)).not.toContain('-starter');
        }
      }
    });

    it('returns 2 for an unknown template, writing nothing', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'graphql'])).toBe(2);
      expect(h.err.text()).toContain('Unknown template "graphql"');
      expect(h.fs.writes).toEqual([]);
    });

    it('scaffolds microservice on cloudflare-workers, swapping in the platform plugin', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'microservice', '--runtime', 'cloudflare-workers']))
        .toBe(0);

      // The capabilities survive the swap; only their provider changes.
      const config = h.fs.read('/work/app/setu.config.ts');
      expect(config).toContain('CloudflarePlugin');
      expect(config).not.toContain('MessagingPlugin');
      // Consuming a queue is a module export, which no plugin option can be.
      expect(h.fs.has('/work/app/src/reply-inbox-object.ts')).toBe(true);
    });

    it('allows rest on cloudflare-workers', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest', '--runtime', 'cloudflare-workers'])).toBe(0);
      expect(h.fs.has('/work/app/wrangler.toml')).toBe(true);
    });

    it('allows microservice on every runtime target', async () => {
      for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers']) {
        const h = harness();
        expect(await h.run(['app', '--template', 'microservice', '--runtime', runtime])).toBe(0);
      }
    });
  });

  it('roots the project at an absolute --dir', async () => {
    const h = harness();
    expect(await h.run(['my-app', '--dir', '/tmp/sandbox'])).toBe(0);
    expect(h.fs.has('/tmp/sandbox/my-app/deno.json')).toBe(true);
  });

  it('anchors a relative --dir to the working directory', async () => {
    const h = harness();
    expect(await h.run(['my-app', '--dir', 'sandbox'])).toBe(0);
    expect(h.fs.has('/work/sandbox/my-app/deno.json')).toBe(true);
  });

  it('normalises the project name to kebab-case', async () => {
    const h = harness();
    expect(await h.run(['MyApp'])).toBe(0);
    expect(h.fs.has('/work/my-app/deno.json')).toBe(true);
  });

  describe('--runtime deno', () => {
    it('emits a deno.json pinning the framework packages', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      const manifest = JSON.parse(h.fs.read('/work/app/deno.json'));
      expect(manifest.imports['@setu-ts/kernel']).toMatch(
        /^jsr:@setu-ts\/kernel@\^/,
      );
      expect(manifest.tasks.start).toContain('main.ts');
    });

    it('emits the serve entry that binds a port', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      const main = h.fs.read('/work/app/main.ts');
      expect(main).toContain("await app.start({ port: Number(runtime.env.PORT ?? '3000') })");
      // The plugin list lives in setu.config.ts, not here.
      expect(main).toContain("from './setu.config.ts'");
      expect(h.fs.read('/work/app/setu.config.ts')).toContain('RuntimePlugin()');
    });

    it('emits no package.json', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      expect(h.fs.has('/work/app/package.json')).toBe(false);
    });

    // A Deno project must not gain an npm manifest just because its template
    // declares npm packages for some other purpose. Beyond being noise, a
    // package.json switches Deno to node_modules resolution, so a project whose
    // import graph reaches a lazily-imported npm driver stops resolving on a cold
    // checkout — the trap `apps/full-stack` documents.
    for (const template of ['rest', 'microservice', 'class-based']) {
      it(`emits no npm manifest for --template ${template}`, async () => {
        const h = harness();

        await h.run(['app', '--runtime', 'deno', '--template', template]);

        expect(h.fs.has('/work/app/package.json')).toBe(false);
        expect(h.fs.has('/work/app/tsconfig.json')).toBe(false);
      });
    }
  });

  for (const runtime of ['node', 'bun']) {
    describe(`--runtime ${runtime} — npm scripts`, () => {
      it('runs the generated test with the runtime own runner, and no frontend build', async () => {
        // These targets declare NO `@std/*`: that harness reaches `Deno.test`
        // internally, so a generated test importing it cannot execute here at
        // all. `bun:test` and `node:test` are built in — verified by running
        // them (`1 pass` / `pass 1`) against real scaffolds.
        //
        // And a `test` script must not be read as "this template has a frontend
        // npm build": a REST project with `npm run build` invoking a tool it
        // does not depend on is a broken script the developer did not ask for.
        const h = harness();

        await h.run(['app', '--runtime', runtime, '--template', 'rest']);

        const pkg = JSON.parse(h.fs.read('/work/app/package.json'));
        expect(pkg.devDependencies?.['@std/expect']).toBeUndefined();
        expect(pkg.devDependencies?.['@std/testing']).toBeUndefined();
        expect(pkg.scripts.test).toBe(runtime === 'bun' ? 'bun test' : 'tsx --test');
        expect(pkg.scripts.build).toBeUndefined();
        expect(pkg.scripts.start).toBeDefined();
      });

      it('keeps the frontend build script for the template that has one', async () => {
        const h = harness();

        await h.run(['app', '--runtime', runtime, '--template', 'full-stack']);

        const pkg = JSON.parse(h.fs.read('/work/app/package.json'));
        expect(pkg.scripts.build).toBe('react-router build');
      });
    });

    describe(`--runtime ${runtime}`, () => {
      it('emits a package.json with npm-compatible JSR specifiers', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime]);
        const manifest = JSON.parse(h.fs.read('/work/app/package.json'));
        expect(manifest.dependencies['@setu-ts/kernel'])
          .toMatch(/^npm:@jsr\/setu-ts__kernel@\^/);
      });

      it('emits the .npmrc that makes the @jsr scope resolvable', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime]);
        expect(h.fs.read('/work/app/.npmrc')).toContain('@jsr:registry=https://npm.jsr.io');
      });

      it('emits a tsconfig enabling the decorators the plugins need', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime]);
        const tsconfig = JSON.parse(h.fs.read('/work/app/tsconfig.json'));
        expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
      });

      it('emits the serve entry and no deno.json', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime]);
        expect(h.fs.read('/work/app/main.ts')).toContain(
          "app.start({ port: Number(runtime.env.PORT ?? '3000') })",
        );
        expect(h.fs.has('/work/app/deno.json')).toBe(false);
      });

      it('declares an npm dependency for every template package', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime, '--template', 'rest']);
        const manifest = JSON.parse(h.fs.read('/work/app/package.json'));
        for (const pkg of ['kernel', 'common', 'runtime', 'openapi-plugin', 'exceptions']) {
          expect(manifest.dependencies[`@setu-ts/${pkg}`])
            .toMatch(new RegExp(`^npm:@jsr/setu-ts__${pkg}@\\^`));
        }
      });
    });
  }

  describe('--runtime cloudflare-workers', () => {
    it('emits a wrangler.toml naming the project and entry', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const wrangler = h.fs.read('/work/app/wrangler.toml');
      expect(wrangler).toContain('name = "app"');
      expect(wrangler).toContain('main = "src/index.ts"');
    });

    it('pins a compatibility date that can import waitUntil', async () => {
      // `import { waitUntil } from 'cloudflare:workers'` shipped 2025-08-08. A
      // project scaffolded against an earlier date cannot import it, so
      // CloudflarePlugin's background-work seam would be unreachable.
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const wrangler = h.fs.read('/work/app/wrangler.toml');

      const match = /compatibility_date = "(\d{4}-\d{2}-\d{2})"/.exec(wrangler ?? '');
      expect(match).not.toBeNull();
      // ISO dates sort lexicographically, so a plain comparison is the check.
      expect((match?.[1] ?? '') > '2025-08-08').toBe(true);
    });

    it('shows where platform bindings are declared', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const wrangler = h.fs.read('/work/app/wrangler.toml');

      expect(wrangler).toContain('[[kv_namespaces]]');
      expect(wrangler).toContain('[[r2_buckets]]');
      expect(wrangler).toContain('cloudflare-plugin');
    });

    it('emits a fetch entry with no listen call', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/app/src/index.ts');
      expect(entry).toContain('export default {');
      expect(entry).toContain('async fetch(request: Request, env: Record<string, unknown>)');
      expect(entry).not.toContain('listen');
      expect(entry).not.toContain('port: 3000');
    });

    it('reads its plugin list from the shared config module', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/app/src/index.ts');
      expect(entry).toContain("import { createApp } from '../setu.config.ts'");
      expect(entry).not.toContain('createApplication');
    });

    it('defers start to the first request so no rejection goes unhandled', async () => {
      // A module-scope start() whose promise is awaited only later leaves a
      // window in which a rejection has no handler attached.
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/app/src/index.ts');
      expect(entry).toContain('await ensureBooted(env);');
      expect(entry).not.toContain('??=');
    });

    it('emits no root main.ts', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      expect(h.fs.has('/work/app/main.ts')).toBe(false);
    });
  });

  describe('--dry-run', () => {
    it('performs zero writes and zero mkdirs', async () => {
      const h = harness();
      expect(await h.run(['app', '--dry-run'])).toBe(0);
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.mkdirs).toEqual([]);
    });

    it('reports each path it would create', async () => {
      const h = harness();
      await h.run(['app', '--dry-run']);
      expect(h.out.text()).toContain('would create /work/app/deno.json');
    });
  });

  it('refuses a workspace base port another local process already holds', async () => {
    const h = harness({}, () => Promise.resolve(false));
    expect(await h.run(['platform', '--workspace', '--port', '3000'])).toBe(1);
    expect(h.err.text()).toContain('Port 3000 is already in use');
    expect(h.fs.writes).toEqual([]);
  });

  describe('usage errors', () => {
    it('returns 2 when the project name is missing', async () => {
      const h = harness();
      expect(await h.run([])).toBe(2);
      expect(h.err.text()).toContain('new <project-name>');
    });

    it('returns 2 for an unsupported runtime', async () => {
      const h = harness();
      expect(await h.run(['app', '--runtime', 'solaris'])).toBe(2);
      expect(h.err.text()).toContain('Unknown runtime "solaris"');
      expect(h.fs.writes).toEqual([]);
    });

    it('returns 2 for a name that normalises to nothing', async () => {
      const h = harness();
      expect(await h.run(['___'])).toBe(2);
      expect(h.err.text()).toContain('Invalid project name');
      expect(h.fs.writes).toEqual([]);
    });

    it('returns 0 for --help, never a usage error', async () => {
      const h = harness();
      expect(await h.run(['--help'])).toBe(0);
      expect(h.out.text()).toContain('new <project-name>');
      expect(h.fs.writes).toEqual([]);
    });

    it('lists every template in --help, from the registry', async () => {
      const h = harness();
      await h.run(['--help']);
      for (const template of listTemplates()) {
        expect(h.out.text()).toContain(template.name);
        expect(h.out.text()).toContain(template.description);
      }
    });

    it('returns 0 for -h', async () => {
      const h = harness();
      expect(await h.run(['-h'])).toBe(0);
    });

    it('treats a leading-dash name as a flag, not a project name', async () => {
      const h = harness();
      expect(await h.run(['---'])).toBe(2);
      expect(h.err.text()).toContain('new <project-name>');
    });
  });

  it('refuses to overwrite an existing project file and writes nothing', async () => {
    const h = harness({ '/work/app/README.md': 'MINE' });
    expect(await h.run(['app'])).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.read('/work/app/README.md')).toBe('MINE');
    expect(h.err.text()).toContain('Refusing to overwrite');
  });

  it('returns 1 and reports the cause when the write fails', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const code = await runNewCommand(parseArgs(['app']), {
      fs: { ...fs, writeFile: () => Promise.reject(new Error('read-only fs')) },
      cwd: '/work',
      log: () => {},
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Failed to write: read-only fs');
  });

  it('reports a non-Error write failure', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const code = await runNewCommand(parseArgs(['app']), {
      fs: { ...fs, writeFile: () => Promise.reject('EROFS') },
      cwd: '/work',
      log: () => {},
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Failed to write: EROFS');
  });

  it('prints next steps naming the created project', async () => {
    const h = harness();
    await h.run(['my-app']);
    expect(h.out.text()).toContain('cd my-app');
    expect(h.out.text()).toContain('deno task start');
  });

  const nextSteps: readonly (readonly [string, string])[] = [
    ['node', 'npm install && npm start'],
    ['bun', 'bun install && bun run start'],
    ['cloudflare-workers', 'npm install && npx wrangler dev'],
  ];

  for (const [runtime, expected] of nextSteps) {
    it(`prints the ${runtime} next step`, async () => {
      const h = harness();
      await h.run(['app', '--runtime', runtime]);
      expect(h.out.text()).toContain(expected);
    });
  }
});

describe('--workspace', () => {
  it('creates a monorepo root rather than a project', async () => {
    const h = harness();
    expect(await h.run(['acme', '--workspace'])).toBe(0);
    for (const file of ['deno.json', 'setu.workspace.json', 'README.md', '.gitignore']) {
      expect(h.fs.has(`/work/acme/${file}`)).toBe(true);
    }
    // A root registers no plugins and starts no server.
    expect(h.fs.has('/work/acme/setu.config.ts')).toBe(false);
    expect(h.fs.has('/work/acme/main.ts')).toBe(false);
  });

  it('declares members by glob, so adding one rewrites nothing', async () => {
    const h = harness();
    await h.run(['acme', '--workspace']);
    const manifest = JSON.parse(h.fs.read('/work/acme/deno.json')) as { workspace?: string[] };
    // Services under apps/, libraries under libs/ — both declared at creation, so
    // neither kind of addition rewrites this file.
    expect(manifest.workspace).toEqual(['./apps/*', './libs/*']);
  });

  it('records the default base port', async () => {
    const h = harness();
    await h.run(['acme', '--workspace']);
    expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json'))).toMatchObject({
      basePort: 3000,
      members: [],
    });
  });

  it('records an explicit --port as the base port', async () => {
    const h = harness();
    expect(await h.run(['acme', '--workspace', '--port', '4100'])).toBe(0);
    expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json'))).toMatchObject({
      basePort: 4100,
    });
  });

  it('points at the add-a-service command as the next step', async () => {
    const h = harness();
    await h.run(['acme', '--workspace']);
    expect(h.out.text()).toContain('Created workspace acme');
    expect(h.out.text()).toContain('generate app orders');
  });

  it('writes nothing under --dry-run', async () => {
    const h = harness();
    expect(await h.run(['acme', '--workspace', '--dry-run'])).toBe(0);
    expect(h.fs.writes).toEqual([]);
    expect(h.out.text()).toContain('/work/acme/setu.workspace.json');
  });

  describe('refusals', () => {
    // A root has nothing to configure, so a template applied to it would be
    // silently dropped — the defect class `generate` once shipped with
    // `--runtime`.
    it('refuses --template, naming where the template belongs', async () => {
      const h = harness();
      expect(await h.run(['acme', '--workspace', '--template', 'rest'])).toBe(2);
      expect(h.err.text()).toContain('generate app <name> --template rest');
      expect(h.fs.writes).toEqual([]);
    });

    // Node and Bun host a workspace; Cloudflare Workers does not, and that is a
    // topology difference rather than a missing profile — each Worker is its own
    // deploy unit with its own wrangler.toml.
    it('accepts every runtime that can host a workspace', async () => {
      for (const runtime of ['deno', 'node', 'bun']) {
        const h = harness();
        expect(await h.run(['acme', '--workspace', '--runtime', runtime])).toBe(0);
        const manifest = JSON.parse(h.fs.read('/work/acme/setu.workspace.json')) as {
          runtime?: string;
        };
        expect(manifest.runtime).toBe(runtime);
      }
    });

    it('refuses Cloudflare Workers, naming why it is not a workspace target', async () => {
      const h = harness();
      expect(await h.run(['acme', '--workspace', '--runtime', 'cloudflare-workers'])).toBe(2);
      expect(h.err.text()).toContain('own deploy unit');
      expect(h.err.text()).toContain('setu new acme --runtime cloudflare-workers');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses the retired independent DI switch', async () => {
      const h = harness();
      expect(await h.run(['acme', '--workspace', '--di'])).toBe(2);
      expect(h.err.text()).toContain('--template class-based');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses --depends-on on the root, which has no members yet', async () => {
      const h = harness();
      expect(await h.run(['acme', '--workspace', '--depends-on', 'orders'])).toBe(2);
      expect(h.err.text()).toContain('generate app');
      expect(h.fs.writes).toEqual([]);
    });

    for (const value of ['abc', '0', '70000', '30.5', '65536']) {
      it(`refuses --port ${value}`, async () => {
        const h = harness();
        expect(await h.run(['acme', '--workspace', '--port', value])).toBe(2);
        expect(h.err.text()).toContain('Invalid --port');
        expect(h.fs.writes).toEqual([]);
      });
    }

    // `parseArgs` cannot consume a flag-shaped token as a value, so `--port -1`
    // and a trailing `--port` both arrive as the boolean `true`. Testing for a
    // string value would let the number the user typed vanish in silence — the
    // exact class this milestone refuses everywhere else.
    for (
      const [label, argv] of [
        ['a negative number', ['acme', '--workspace', '--port', '-1']],
        ['no value at all', ['acme', '--workspace', '--port']],
      ] as const
    ) {
      it(`refuses --port with ${label}`, async () => {
        const h = harness();
        expect(await h.run([...argv])).toBe(2);
        expect(h.err.text()).toContain('--port needs a value');
        expect(h.fs.writes).toEqual([]);
      });
    }

    // The transport describes how a workspace's members reach each other, and a
    // standalone project has none — accepting it would report success for a
    // project that registers nothing of the kind.
    for (const flag of ['--transport', '--transport-url']) {
      it(`refuses ${flag} on a standalone project`, async () => {
        const h = harness();
        expect(await h.run(['acme', flag, 'redis'])).toBe(2);
        expect(h.err.text()).toContain('--workspace');
        expect(h.fs.writes).toEqual([]);
      });
    }

    it('refuses --port with no value on a standalone project too', async () => {
      const h = harness();
      expect(await h.run(['acme', '--port'])).toBe(2);
      expect(h.err.text()).toContain('--workspace');
      expect(h.fs.writes).toEqual([]);
    });

    // `--port` allocates MEMBER ports; a standalone project's entry binds the
    // port its own `main.ts` names, so accepting it would report success for a
    // project that ignores the number.
    it('refuses --port on a standalone project', async () => {
      const h = harness();
      expect(await h.run(['acme', '--port', '4100'])).toBe(2);
      expect(h.err.text()).toContain('--workspace');
      expect(h.fs.writes).toEqual([]);
    });
  });
});

describe('--workspace --transport', () => {
  /**
   * Reads the manifest of a workspace scaffolded with the given flags.
   *
   * @param argv - Arguments after the project name
   * @returns The harness and the parsed manifest
   */
  async function workspaceWith(argv: readonly string[]) {
    const h = harness();
    const code = await h.run(['acme', '--workspace', ...argv]);
    return { h, code };
  }

  it('records http when no transport is named, so the default is explicit', async () => {
    const { h, code } = await workspaceWith([]);
    expect(code).toBe(0);
    expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json'))).toMatchObject({
      transport: 'http',
    });
  });

  for (const transport of ['grpc', 'memory', 'redis', 'rabbitmq', 'nats', 'kafka']) {
    it(`records the ${transport} transport`, async () => {
      const { h, code } = await workspaceWith(['--transport', transport]);
      expect(code).toBe(0);
      expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json'))).toMatchObject({ transport });
    });
  }

  it('describes the chosen transport in the workspace README', async () => {
    const { h } = await workspaceWith(['--transport', 'redis']);
    expect(h.fs.read('/work/acme/README.md')).toContain('redis');
    expect(h.fs.read('/work/acme/README.md')).toContain('Redis Streams');
  });

  it('records an endpoint override beside the transport', async () => {
    const { h, code } = await workspaceWith([
      '--transport',
      'redis',
      '--transport-url',
      'redis://shared:6379',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json'))).toMatchObject({
      transport: 'redis',
      transportUrl: 'redis://shared:6379',
    });
  });

  // The manifest states a CHOICE; restating a constant the CLI already holds
  // would invite the two to drift.
  it('omits the endpoint when it was not overridden', async () => {
    const { h } = await workspaceWith(['--transport', 'redis']);
    expect(JSON.parse(h.fs.read('/work/acme/setu.workspace.json')).transportUrl).toBeUndefined();
  });

  describe('refusals', () => {
    it('refuses an unknown transport, naming every real one', async () => {
      const { h, code } = await workspaceWith(['--transport', 'carrier-pigeon']);
      expect(code).toBe(2);
      expect(h.err.text()).toContain('Unknown transport "carrier-pigeon"');
      expect(h.err.text()).toContain('rabbitmq');
      expect(h.fs.writes).toEqual([]);
    });

    // There is no raw-TCP transport here. Accepting `tcp` as a synonym for HTTP
    // would leave the user believing they chose something.
    it('refuses tcp by explaining what it actually maps to', async () => {
      const { h, code } = await workspaceWith(['--transport', 'tcp']);
      expect(code).toBe(2);
      expect(h.err.text()).toContain('no raw tcp transport');
      expect(h.err.text()).toContain('--transport http');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses --transport with no value', async () => {
      const { h, code } = await workspaceWith(['--transport']);
      expect(code).toBe(2);
      expect(h.err.text()).toContain('--transport needs a value');
    });

    it('refuses --transport-url with no value', async () => {
      const { h, code } = await workspaceWith(['--transport', 'redis', '--transport-url']);
      expect(code).toBe(2);
      expect(h.err.text()).toContain('--transport-url needs a value');
    });

    // A transport with no broker has nothing to address, so storing the URL
    // would put a value in the manifest no generated config ever reads.
    for (const transport of ['http', 'grpc', 'memory']) {
      it(`refuses --transport-url for ${transport}, which has no broker`, async () => {
        const { h, code } = await workspaceWith([
          '--transport',
          transport,
          '--transport-url',
          'redis://x:1',
        ]);
        expect(code).toBe(2);
        expect(h.err.text()).toContain('has no broker');
        expect(h.fs.writes).toEqual([]);
      });
    }
  });
});

// The primary non-interactive guarantee is that `ask` is OPTIONAL, not TTY
// detection: every gate reaches the CLI through an in-process runCli that
// passes none. These tests pin what that guarantee promises.
describe('the interactive seam on setu new', () => {
  /** A prompter that would fail the test the moment it is consulted. */
  const refusingPrompter = () => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      prompter: {
        select(): Promise<string | undefined> {
          calls++;
          return Promise.resolve(undefined);
        },
      },
    };
  };

  it('produces a byte-identical file set with no ask as with --yes', async () => {
    // The default world must not depend on how it was reached: no prompter at
    // all (every gate) and an explicit --yes are the same scaffold.
    const plain = harness();
    expect(await plain.run(['svc', '--template', 'microservice'])).toBe(0);
    const yes = harness();
    expect(await yes.run(['svc', '--template', 'microservice', '--yes'])).toBe(0);

    const pathsOf = (h: Harness) =>
      h.fs.writes.map((path) => [path, h.fs.read(path)] as const).sort(([a], [b]) =>
        a < b ? -1 : 1
      );
    expect(pathsOf(yes)).toEqual(pathsOf(plain));
  });

  it('asks nothing under --yes even when a prompter is present', async () => {
    const { prompter, calls } = refusingPrompter();
    const fs = createFakeFs();
    const out = createRecorder();
    const err = createRecorder();
    const code = await runNewCommand(parseArgs(['svc', '--yes']), {
      fs,
      cwd: '/work',
      log: out.sink,
      error: err.sink,
      ask: prompter,
    });
    expect(code).toBe(0);
    expect(calls).toBe(0);
  });

  it('still refuses --transport standalone and names the flags that do apply', async () => {
    const h = harness();
    expect(await h.run(['svc', '--transport', 'redis'])).toBe(2);
    expect(h.err.text()).toContain('--broker');
    expect(h.err.text()).toContain('--queue');
  });

  it('honors prompted answers by rewriting the flag record', async () => {
    const scripted = {
      select(question: string): Promise<string | undefined> {
        return Promise.resolve(question.startsWith('Template?') ? 'microservice' : undefined);
      },
    };
    const fs = createFakeFs();
    const code = await runNewCommand(parseArgs(['svc']), {
      fs,
      cwd: '/work',
      log: () => {},
      error: () => {},
      ask: scripted,
    });
    expect(code).toBe(0);
    // The prompted template took effect through the ordinary pipeline.
    expect(fs.read('/work/svc/setu.config.ts')).toContain('MessagingPlugin()');
  });
});

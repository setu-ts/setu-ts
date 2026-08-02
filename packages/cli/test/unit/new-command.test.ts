import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { firstDuplicatePath, runNewCommand } from '../../src/commands/new.ts';
import { listTemplates } from '../../src/templates/registry.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runNewCommand(parseArgs(argv), { fs, cwd: '/work', log: out.sink, error: err.sink }),
  };
}

describe('firstDuplicatePath', () => {
  // The overwrite check probes the filesystem, so it cannot see a path planned
  // twice within one project — both would be written and the last would win.
  it('finds a path planned twice', () => {
    expect(firstDuplicatePath([
      { path: 'deno.json', contents: '{}' },
      { path: 'main.ts', contents: '' },
      { path: 'deno.json', contents: 'overwrites the framework manifest' },
    ])).toBe('deno.json');
  });

  it('returns the FIRST duplicate when there are several', () => {
    expect(firstDuplicatePath([
      { path: 'a', contents: '' },
      { path: 'b', contents: '' },
      { path: 'a', contents: '' },
      { path: 'b', contents: '' },
    ])).toBe('a');
  });

  it('returns undefined for a distinct plan', () => {
    expect(firstDuplicatePath([
      { path: 'deno.json', contents: '' },
      { path: 'main.ts', contents: '' },
    ])).toBeUndefined();
  });

  it('returns undefined for an empty plan', () => {
    expect(firstDuplicatePath([])).toBeUndefined();
  });

  it('reports no duplicate for any built-in template on any runtime', async () => {
    // The invariant the guard protects: a template's own files must never
    // collide with the fixed project files, for any target.
    for (const template of listTemplates()) {
      for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
        // A pairing the template refuses never reaches the plan.
        if (template.unsupported[runtime] !== undefined) continue;

        const h = harness();
        const code = await h.run(['app', '--template', template.name, '--runtime', runtime]);
        expect(code).toBe(0);
        expect(h.err.lines.join('\n')).not.toContain('twice');
      }
    }
  });
});

describe('runNewCommand', () => {
  it('creates a deno project under the working directory by default', async () => {
    const h = harness();
    expect(await h.run(['my-app'])).toBe(0);
    for (const file of ['deno.json', 'main.ts', 'honoe.config.ts', 'README.md', '.gitignore']) {
      expect(h.fs.has(`/work/my-app/${file}`)).toBe(true);
    }
  });

  describe('the honoe.config.ts seam', () => {
    it('is emitted even without --template', async () => {
      // Plugin-command discovery needs one seam that always exists.
      const h = harness();
      await h.run(['app']);
      expect(h.fs.read('/work/app/honoe.config.ts')).toContain('export function createApp()');
    });

    it('carries only the runtime plugin without --template', async () => {
      const h = harness();
      await h.run(['app']);
      const config = h.fs.read('/work/app/honoe.config.ts');
      expect(config).toContain('RuntimePlugin()');
      expect(config).not.toContain('ConfigPlugin');
      expect(config).not.toContain('errorHandler');
    });

    it('does not start the application — main.ts owns that', async () => {
      // Importing this module must never bind a socket.
      const h = harness();
      await h.run(['app']);
      expect(h.fs.read('/work/app/honoe.config.ts')).not.toContain('.start(');
    });

    it('is the only place main.ts gets its plugin list from', async () => {
      const h = harness();
      await h.run(['app']);
      const main = h.fs.read('/work/app/main.ts');
      expect(main).toContain("import { createApp } from './honoe.config.ts'");
      expect(main).toContain('app.start({ port: 3000 })');
      expect(main).not.toContain('RuntimePlugin');
      expect(main).not.toContain('createApplication');
    });
  });

  describe('a template that composes through a starter factory', () => {
    it('awaits the factory instead of calling createApplication', async () => {
      const h = harness();
      expect(await h.run(['shop', '--template', 'full-stack'])).toBe(0);
      const config = h.fs.read('/work/shop/honoe.config.ts');

      expect(config).toContain('await createFullStackAppFromConfig(');
      expect(config).toContain("from '@hono-enterprise/full-stack-starter'");
      // The kernel is not on this path at all.
      expect(config).not.toContain('createApplication');
      expect(config).not.toContain('@hono-enterprise/kernel');
    });

    it('exports an async factory, which the loader already awaits', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const config = h.fs.read('/work/shop/honoe.config.ts');

      expect(config).toContain('export async function createApp(');
      expect(config).toContain('): Promise<IApplication> {');
      // Still must not start the server: command discovery imports this module.
      expect(config).not.toContain('.start(');
    });

    it('pins the starter in the manifest and drops the kernel', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const manifest = JSON.parse(h.fs.read('/work/shop/deno.json'));

      expect(manifest.imports['@hono-enterprise/full-stack-starter']).toContain(
        'jsr:@hono-enterprise/full-stack-starter@',
      );
      // Declaring the kernel would name a package the project never imports.
      expect(manifest.imports['@hono-enterprise/kernel']).toBeUndefined();
      // Still needed: the config module imports the IApplication type.
      expect(manifest.imports['@hono-enterprise/common']).toBeDefined();
    });

    it('declares every package the generated config imports', async () => {
      const h = harness();
      await h.run(['shop', '--template', 'full-stack']);
      const config = h.fs.read('/work/shop/honoe.config.ts');
      const manifest = JSON.parse(h.fs.read('/work/shop/deno.json'));

      for (const match of config.matchAll(/from '(@hono-enterprise\/[a-z-]+)'/g)) {
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
      const config = h.fs.read('/work/shop/honoe.config.ts');

      expect(entry).toContain('async fetch(request: Request, env: Record<string, unknown>)');
      expect(entry).toContain('booted ??= boot(env)');
      expect(entry).toContain('createApp(env)');
      expect(config).toContain('env?: Readonly<Record<string, unknown>>');
      expect(config).toContain('{ env }');
    });

    it('threads env through the Workers entry for a template without a factory too', async () => {
      // Not only the factory path needs it: with no ambient environment on the
      // edge, an inline-wiring app whose RuntimePlugin never receives `env`
      // registers runtime services whose `env` is empty, so ConfigPlugin and
      // the secrets EnvProvider read nothing.
      const h = harness();
      await h.run(['api', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/api/src/index.ts');
      const config = h.fs.read('/work/api/honoe.config.ts');

      expect(entry).toContain('async fetch(request: Request, env: Record<string, unknown>)');
      expect(entry).toContain('booted ??= boot(env);');
      expect(entry).toContain('createApp(env)');
      expect(config).toContain('export function createApp(env: Readonly<Record<string, unknown>>');
      expect(config).toContain('RuntimePlugin({ env })');
    });

    it('leaves templates without a factory rendering exactly as before', async () => {
      // The field is additive: the rest template must be untouched by it.
      const h = harness();
      await h.run(['api', '--template', 'rest']);
      const config = h.fs.read('/work/api/honoe.config.ts');

      expect(config).toContain('export function createApp(): IApplication');
      expect(config).toContain('createApplication({');
      expect(config).toContain("app.router.get('/'");
      expect(config).not.toContain('await create');
    });
  });

  describe('--template', () => {
    it('writes the rest plugin set into honoe.config.ts', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      const config = h.fs.read('/work/app/honoe.config.ts');
      for (
        const symbol of [
          'RuntimePlugin',
          'ConfigPlugin',
          'LoggerPlugin',
          'ValidationPlugin',
          'HttpSecurityPlugin',
          'HealthPlugin',
          'MetricsPlugin',
          'OpenApiPlugin',
        ]
      ) {
        expect(config).toContain(`${symbol}()`);
      }
    });

    it('adds errorHandler through middleware.add, not the plugin list', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const config = h.fs.read('/work/app/honoe.config.ts');
      expect(config).toContain("import { errorHandler } from '@hono-enterprise/exceptions';");
      expect(config).not.toContain('ExceptionsPlugin');
    });

    it('registers errorHandler at priority 0, the outermost position', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const config = h.fs.read('/work/app/honoe.config.ts');

      // `errorHandler`'s contract requires the outermost slot. A bare `add()`
      // takes the pipeline default of 500, which sits INSIDE the metrics
      // middleware at 20 — so a throw there escapes the try/catch entirely and
      // the project answers with a bare adapter 500, no RFC 7807 body, no log.
      expect(config).toContain(
        "app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });",
      );
      expect(config).not.toContain('app.middleware.add(errorHandler());');
    });

    it('registers errorHandler at priority 0 for the microservice template too', async () => {
      const h = harness();
      await h.run(['app', '--template', 'microservice']);
      const config = h.fs.read('/work/app/honoe.config.ts');

      // The microservice set adds telemetry middleware at 30, so the same
      // ordering requirement applies — and it composes REST_MIDDLEWARE, so this
      // guards that the shared list keeps carrying its position.
      expect(config).toContain(
        "app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });",
      );
    });

    it('declares a manifest import for every package the config references', async () => {
      const h = harness();
      await h.run(['app', '--template', 'rest']);
      const manifest = JSON.parse(h.fs.read('/work/app/deno.json'));
      const config = h.fs.read('/work/app/honoe.config.ts');
      for (const specifier of Object.keys(manifest.imports)) {
        expect(typeof manifest.imports[specifier]).toBe('string');
      }
      // Every import in the generated source must be declared in the manifest.
      for (const match of config.matchAll(/from '(@hono-enterprise\/[a-z-]+)'/g)) {
        expect(Object.keys(manifest.imports)).toContain(match[1]);
      }
    });

    it('makes microservice a superset of rest in the emitted config', async () => {
      const rest = harness();
      await rest.run(['app', '--template', 'rest']);
      const micro = harness();
      await micro.run(['app', '--template', 'microservice']);
      const microConfig = micro.fs.read('/work/app/honoe.config.ts');
      for (const symbol of ['ConfigPlugin', 'OpenApiPlugin', 'errorHandler']) {
        expect(microConfig).toContain(symbol);
      }
      for (
        const symbol of ['MessagingPlugin', 'QueuePlugin', 'ResiliencePlugin', 'TelemetryPlugin']
      ) {
        expect(microConfig).toContain(`${symbol}()`);
        expect(rest.fs.read('/work/app/honoe.config.ts')).not.toContain(symbol);
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

    it('refuses microservice on cloudflare-workers, naming the reason', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'microservice', '--runtime', 'cloudflare-workers']))
        .toBe(2);
      expect(h.err.text()).toContain('does not support --runtime cloudflare-workers');
      expect(h.err.text()).toContain('sockets');
      expect(h.fs.writes).toEqual([]);
    });

    it('allows rest on cloudflare-workers', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest', '--runtime', 'cloudflare-workers'])).toBe(0);
      expect(h.fs.has('/work/app/wrangler.toml')).toBe(true);
    });

    it('allows microservice on every socket-capable runtime', async () => {
      for (const runtime of ['deno', 'node', 'bun']) {
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
      expect(manifest.imports['@hono-enterprise/kernel']).toMatch(
        /^jsr:@hono-enterprise\/kernel@\^/,
      );
      expect(manifest.tasks.start).toContain('main.ts');
    });

    it('emits the serve entry that binds a port', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      const main = h.fs.read('/work/app/main.ts');
      expect(main).toContain('await app.start({ port: 3000 })');
      // The plugin list lives in honoe.config.ts, not here.
      expect(main).toContain("from './honoe.config.ts'");
      expect(h.fs.read('/work/app/honoe.config.ts')).toContain('RuntimePlugin()');
    });

    it('emits no package.json', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      expect(h.fs.has('/work/app/package.json')).toBe(false);
    });
  });

  for (const runtime of ['node', 'bun']) {
    describe(`--runtime ${runtime}`, () => {
      it('emits a package.json with npm-compatible JSR specifiers', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime]);
        const manifest = JSON.parse(h.fs.read('/work/app/package.json'));
        expect(manifest.dependencies['@hono-enterprise/kernel'])
          .toMatch(/^npm:@jsr\/hono-enterprise__kernel@\^/);
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
        expect(h.fs.read('/work/app/main.ts')).toContain('app.start({ port: 3000 })');
        expect(h.fs.has('/work/app/deno.json')).toBe(false);
      });

      it('declares an npm dependency for every template package', async () => {
        const h = harness();
        await h.run(['app', '--runtime', runtime, '--template', 'rest']);
        const manifest = JSON.parse(h.fs.read('/work/app/package.json'));
        for (const pkg of ['kernel', 'common', 'runtime', 'openapi-plugin', 'exceptions']) {
          expect(manifest.dependencies[`@hono-enterprise/${pkg}`])
            .toMatch(new RegExp(`^npm:@jsr/hono-enterprise__${pkg}@\\^`));
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
      expect(entry).toContain("import { createApp } from '../honoe.config.ts'");
      expect(entry).not.toContain('createApplication');
    });

    it('defers start to the first request so no rejection goes unhandled', async () => {
      // A module-scope start() whose promise is awaited only later leaves a
      // window in which a rejection has no handler attached.
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/app/src/index.ts');
      expect(entry).toContain('booted ??= boot(env);');
      expect(entry).toContain('const app = await booted;');
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

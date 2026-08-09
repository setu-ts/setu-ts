import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { firstDuplicatePath, resolveHost, runNewCommand } from '../../src/commands/new.ts';
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

// Node's built-in TypeScript support ERASES types without transforming code, so
// `node --experimental-strip-types main.ts` — what this CLI emitted through
// alpha.5 — cannot run a legacy decorator or a constructor parameter property.
// Measured on Node v24: a scaffolded Node project booted until the first
// `g service|controller|module`, and `--template nest` never booted at all,
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
    // A start script naming a binary the manifest does not install is a project
    // that reports success and then cannot run.
    const manifest = await manifestOf('node');
    expect(manifest.devDependencies?.['tsx']).toBeDefined();
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

  it('emits no devDependencies block when there is nothing to declare', async () => {
    // Deno and Workers have no package.json at all unless a template needs one,
    // so this pins the Bun path: no runtime devDeps, template devDeps only.
    const h = harness();
    expect(await h.run(['app', '--runtime', 'bun'])).toBe(0);
    const manifest = JSON.parse(h.fs.read('/work/app/package.json')) as Record<string, unknown>;
    expect(Object.keys(manifest)).toContain('dependencies');
  });
});

describe('resolveHost', () => {
  // Every host in the registry declares `localImports` and `files`, so these
  // fallbacks are unreachable through `runNewCommand`. They are not dead —
  // `TemplateHost` declares both optional — so they are driven here directly
  // rather than left as an untested path behind a template that happens not to
  // exercise them.
  it('fills in every optional member of a bare host', () => {
    const resolved = resolveHost(
      { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
      { di: false },
    );
    expect(resolved.localImports).toEqual([]);
    expect(resolved.packageImports).toEqual([]);
    expect(resolved.files).toEqual([]);
    expect(resolved.pluginSpreads).toEqual([]);
    expect(resolved.setupCalls).toEqual([]);
    expect(resolved.appFactory).toBeUndefined();
    expect(resolved.manifest).toBeUndefined();
  });

  it('applies --di to a plugin-list host', () => {
    const resolved = resolveHost(
      { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
      { di: true },
    );
    expect(resolved.plugins.map((w) => w.pkg)).toEqual(['runtime', 'di-plugin']);
  });

  // A starter factory owns the whole plugin set, so a wiring appended here
  // would be silently dropped by the renderer's factory branch. The flag
  // reaches that template through the factory's own options instead.
  it('leaves a factory host plugin list alone under --di', () => {
    const resolved = resolveHost(
      { plugins: [], middleware: [], appFactory: { pkg: 'full-stack-starter', symbol: 'x' } },
      { di: true },
    );
    expect(resolved.plugins).toEqual([]);
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
      expect(main).toContain('app.start({ port: 3000 })');
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
      const config = h.fs.read('/work/api/setu.config.ts');

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
      const config = h.fs.read('/work/api/setu.config.ts');

      expect(config).toContain('export function createApp(): IApplication');
      expect(config).toContain('createApplication({');
      expect(config).toContain("app.router.get('/'");
      expect(config).not.toContain('await create');
    });
  });

  describe('--template', () => {
    it('writes the rest plugin set into setu.config.ts', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      const config = h.fs.read('/work/app/setu.config.ts');
      for (
        const symbol of [
          'RuntimePlugin',
          'ConfigPlugin',
          'LoggerPlugin',
          'ValidationPlugin',
          'HttpSecurityPlugin',
          'OpenApiPlugin',
        ]
      ) {
        expect(config).toContain(`${symbol}()`);
      }
      // Three plugins take a generated-artifact seam, so they are NOT argument-free.
      // Asserted by their actual call so a dropped seam shows up here rather than only
      // in the drift gate.
      expect(config).toContain('HealthPlugin({ indicators: [...HEALTH_INDICATORS] })');
      expect(config).toContain('MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })');
      expect(config).toContain('DecoratorPlugin({');
    });

    it('renders the plugin list, middleware, setup calls, then the index route', async () => {
      const h = harness();
      expect(await h.run(['app', '--template', 'rest'])).toBe(0);
      const config = h.fs.read('/work/app/setu.config.ts');

      const order = [
        'createApplication({',
        'app.middleware.add(errorHandler()',
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
      expect(h.fs.read('/work/bare/src/routes/index.ts')).toContain('registerGeneratedRoutes');
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
      expect(h.fs.has('/work/bare/src/controllers/index.ts')).toBe(false);
      expect(h.fs.has('/work/bare/src/cqrs/index.ts')).toBe(false);
    });

    describe('--di', () => {
      // The flag's whole contract: it forks the COMPOSITION, never the generated
      // source. Every file but the config must be untouched.
      it('changes setu.config.ts and nothing else', async () => {
        const plain = harness();
        const withDi = harness();
        expect(await plain.run(['app', '--template', 'rest'])).toBe(0);
        expect(await withDi.run(['app', '--template', 'rest', '--di'])).toBe(0);

        for (const path of plain.fs.writes) {
          if (path.endsWith('setu.config.ts')) continue;
          // deno.json is the one legitimate exception: it must gain the pin.
          if (path.endsWith('deno.json')) continue;
          expect(withDi.fs.read(path)).toBe(plain.fs.read(path));
        }
      });

      it('adds exactly one plugin call to a plugin-list template', async () => {
        const plain = harness();
        const withDi = harness();
        await plain.run(['app', '--template', 'rest']);
        await withDi.run(['app', '--template', 'rest', '--di']);

        const before = plain.fs.read('/work/app/setu.config.ts');
        const after = withDi.fs.read('/work/app/setu.config.ts');

        expect(before).not.toContain('DiPlugin');
        expect(after).toContain('      DiPlugin(),');
        expect(after).toContain("import { DiPlugin } from '@setu-ts/di-plugin';");
        // Exactly one: a second would throw `Duplicate plugin name` at start().
        expect(after.match(/DiPlugin\(\)/g)?.length).toBe(1);
      });

      it('declares di-plugin in the manifest it now imports', async () => {
        // The renderer and the manifest writer read ONE resolved plugin list, so
        // a --di project can never import a package it does not declare.
        const h = harness();
        await h.run(['app', '--template', 'rest', '--di']);
        const manifest = JSON.parse(h.fs.read('/work/app/deno.json'));
        expect(manifest.imports['@setu-ts/di-plugin']).toContain('jsr:@setu-ts/di-plugin@');
      });

      it('wires DI into a template-less project too', async () => {
        const h = harness();
        await h.run(['bare', '--di']);
        const config = h.fs.read('/work/bare/setu.config.ts');
        expect(config).toContain('DiPlugin(),');
        expect(JSON.parse(h.fs.read('/work/bare/deno.json')).imports['@setu-ts/di-plugin'])
          .toBeDefined();
      });

      // The defect this milestone was most likely to ship: `nest` ALREADY
      // registers DiPlugin, and the kernel throws `Duplicate plugin name 'di'`
      // at start(). A second registration type-checks and passes every file
      // assertion; only booting the project would catch it.
      it('leaves --template nest byte-identical, because it already has DI', async () => {
        const plain = harness();
        const withDi = harness();
        expect(await plain.run(['app', '--template', 'nest'])).toBe(0);
        expect(await withDi.run(['app', '--template', 'nest', '--di'])).toBe(0);

        expect(withDi.fs.writes).toEqual(plain.fs.writes);
        for (const path of plain.fs.writes) {
          expect(withDi.fs.read(path)).toBe(plain.fs.read(path));
        }

        const config = withDi.fs.read('/work/app/setu.config.ts');
        expect(config.match(/DiPlugin\(\)/g)?.length).toBe(1);
      });

      it('reaches full-stack through the starter option, not the plugin list', async () => {
        // `TemplateHost.plugins` must stay empty when an appFactory is set, so a
        // wiring appended there would be silently dropped by the renderer.
        const h = harness();
        expect(await h.run(['shop', '--template', 'full-stack', '--di'])).toBe(0);
        const config = h.fs.read('/work/shop/setu.config.ts');
        expect(config).toContain('di: {},');
        expect(config).not.toContain('DiPlugin');
        expect(config).not.toContain('createApplication');
      });

      it('leaves full-stack without the option when the flag is absent', async () => {
        const h = harness();
        await h.run(['shop', '--template', 'full-stack']);
        expect(h.fs.read('/work/shop/setu.config.ts')).not.toContain('di: {}');
      });
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
        "app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });",
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
        "app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });",
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
      expect(manifest.imports['@setu-ts/kernel']).toMatch(
        /^jsr:@setu-ts\/kernel@\^/,
      );
      expect(manifest.tasks.start).toContain('main.ts');
    });

    it('emits the serve entry that binds a port', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'deno']);
      const main = h.fs.read('/work/app/main.ts');
      expect(main).toContain('await app.start({ port: 3000 })');
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
    for (const template of ['rest', 'microservice', 'nest']) {
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
      it('declares the module test dependencies without a frontend build script', async () => {
        // The `rest` template declares @std/* so the module schematic's emitted
        // test can run. That must NOT be read as "this template has a frontend
        // npm build" — a REST project with `npm run build` invoking a tool it
        // does not depend on is a broken script the developer did not ask for.
        const h = harness();

        await h.run(['app', '--runtime', runtime, '--template', 'rest']);

        const pkg = JSON.parse(h.fs.read('/work/app/package.json'));
        expect(pkg.devDependencies['@std/expect']).toBe('npm:@jsr/std__expect@^1.0.20');
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
        expect(h.fs.read('/work/app/main.ts')).toContain('app.start({ port: 3000 })');
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

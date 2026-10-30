import { describe, expect, it } from 'vitest';
import {
  BROKER_COMPOSE_FILE,
  projectFiles,
  resolveHost,
  servedRoutes,
} from '../../../src/templates/project-files.ts';
import type { TargetRuntime } from '../../../src/constants.ts';
import { getTemplate } from '../../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { VERSION } from '../../../src/version.ts';
import { withQueueArgs } from '../../../src/templates/broker.ts';
import { getTransport } from '../../../src/workspace/transport.ts';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';
import { withPluginOptionSeams } from '../../../src/templates/seam.ts';
import { JOBS_SEAM } from '../../../src/seams/jobs.ts';

describe('functional hosts and generated test tasks', () => {
  it('emits the TLS proxy setting and warns about universal trust (M119c)', () => {
    const files = [
      ...projectFiles('shop', 'node', resolveHost(getTemplate('full-stack')!, 'node')),
    ];
    const config = contentsOf(files, 'setu.config.ts');
    expect(config).toContain("config.get<string>('TRUSTED_PROXIES', { default: '' })");
    expect(config).toContain(".split(',')");
    expect(config).toContain('.filter((entry) => entry.length > 0)');
    expect(config).toContain('trustedProxies.length > 0');
    for (const file of ['.env', '.env.example', 'README.md']) {
      const source = contentsOf(files, file);
      expect(source).toContain('TRUSTED_PROXIES');
      expect(source).toContain('0.0.0.0/0');
      expect(source).toMatch(/single IPv6 addresses|IPv6 proxies as single addresses/);
      expect(source).toContain('forwarded');
      expect(source).toContain('400');
    }
    expect(contentsOf(files, 'README.md')).toContain('## Behind a TLS proxy');
    // Audit L1: `::/0` is compared literally and trusts nothing, so no file may claim it trusts all.
    for (const file of ['.env', '.env.example', 'README.md']) {
      expect(contentsOf(files, file)).not.toContain('::/0');
    }
  });
  for (const target of ['node', 'deno', 'bun', 'cloudflare-workers'] as const) {
    for (const name of ['minimal', 'rest', 'microservice', 'full-stack']) {
      it(`starts flat and splits unit/e2e tasks for ${name} on ${target}`, () => {
        const host = resolveHost(name === 'minimal' ? MINIMAL_HOST : getTemplate(name)!, target);
        const files = [...projectFiles('svc', target, host)];
        const config = contentsOf(files, 'setu.config.ts');
        // A new project starts flat: the first `setu g module` writes the module
        // barrel and switches these lines.
        expect(config).toContain(
          "import { registerGeneratedRoutes } from './src/controllers/index.ts'",
        );
        expect(config).toContain('registerGeneratedRoutes(app.router, app.services);');
        expect(config).not.toContain('registerModules');
        expect(files.some((file) => file.path === 'src/modules/index.ts')).toBe(false);
        // V10-23: every target, Workers included, emits socket test support and
        // the app-level e2e smoke test. Workers boots the real Worker on workerd
        // through the same `startTestServer()`.
        expect(files.some((file) => file.path === 'test/support/server.ts')).toBe(true);
        expect(files.some((file) => file.path === 'test/e2e/app.e2e.test.ts')).toBe(true);
        // Deno runs its tasks from `deno.json`; every npm-manifest target,
        // Workers included, declares its test scripts in `package.json`.
        const manifest = JSON.parse(
          contentsOf(files, target === 'deno' ? 'deno.json' : 'package.json'),
        ) as { scripts?: Record<string, string>; tasks?: Record<string, string> };
        const tasks = manifest.tasks ?? manifest.scripts!;
        if (name === 'full-stack' || name === 'rest' || name === 'microservice') {
          const dependencies = JSON.parse(
            contentsOf(
              files,
              target === 'deno' || target === 'cloudflare-workers' ? 'deno.json' : 'package.json',
            ),
          ) as { imports?: Record<string, string>; dependencies?: Record<string, string> };
          expect(dependencies.imports?.['zod'] ?? dependencies.dependencies?.['zod']).toBe(
            target === 'deno' || target === 'cloudflare-workers' ? 'npm:zod@^4.6.6' : '^4.6.6',
          );
        }
        const unit =
          target === 'deno'
            ? "deno test -A --ignore='**/*.e2e.test.ts'"
            : target === 'bun'
              ? "bun test --path-ignore-patterns='**/*.e2e.test.ts'"
              : "tsx --test --test-force-exit '**/!(*.e2e).test.ts'";
        const e2e =
          target === 'deno'
            ? "deno test -A '**/*.e2e.test.ts'"
            : target === 'bun'
              ? 'bun test .e2e.test'
              : "tsx --test --test-force-exit '**/*.e2e.test.ts'";
        const prefix =
          name !== 'full-stack'
            ? ''
            : target === 'deno'
              ? 'deno task build && '
              : target === 'cloudflare-workers'
                ? 'npm run build && '
                : 'react-router build && ';
        expect(tasks['test']).toBe(prefix + unit);
        expect(tasks['test:e2e']).toBe(prefix + e2e);
        const test = contentsOf(files, 'test/e2e/app.e2e.test.ts');
        expect(test).toContain('fetch(server.baseUrl + path)');
        expect(test).not.toContain('inject');
        if (name === 'rest') {
          expect(test).toContain('/greetings');
          // The greeting example is a flat function controller and its service.
          expect(files.some((file) => file.path.startsWith('src/modules/'))).toBe(false);
          expect(contentsOf(files, 'src/controllers/greeting.controller.ts')).toContain(
            "from '../services/greeting.service.ts'",
          );
          expect(contentsOf(files, 'src/controllers/index.ts')).toContain('registerGreetingRoutes');
          expect(files.some((file) => file.path.endsWith('greeting.schemas.ts'))).toBe(false);
        }
      });
    }
  }
});

describe('guidance and queue seam composition', () => {
  for (const [runtime, invocation] of [
    ['node', 'npx @setu-ts/cli@'],
    ['cloudflare-workers', 'npx @setu-ts/cli@'],
    ['bun', 'bunx @setu-ts/cli@'],
    ['deno', 'deno run -A npm:@setu-ts/cli@'],
  ] as const) {
    it(`README command resolves through the pinned CLI on ${runtime}`, () => {
      const readme = contentsOf(
        [...projectFiles('svc', runtime, resolveHost(MINIMAL_HOST, runtime))],
        'README.md',
      );
      expect(readme).toContain(`${invocation}${VERSION} generate service billing`);
      expect(readme).toContain(`${invocation}${VERSION} generate --help`);
    });
  }
  it('Workers microservice resolves seams after removing queue-plugin', () => {
    const host = resolveHost(getTemplate('microservice')!, 'cloudflare-workers');
    const files = [...projectFiles('svc', 'cloudflare-workers', host)];
    expect(files.map((file) => file.path)).not.toContain('src/jobs/index.ts');
    const config = contentsOf(files, 'setu.config.ts');
    expect(config).not.toContain('QUEUE_PROCESSORS');
    expect(config).not.toContain('QueuePlugin');
    expect(config).toContain('CloudflarePlugin');
  });
  it('microservice queue seam preserves redis transport in either composition order', () => {
    const host = resolveHost(getTemplate('microservice')!, 'deno');
    const config = contentsOf([...projectFiles('svc', 'deno', host)], 'setu.config.ts');
    expect(config).toContain('QueuePlugin({ processors: [...QUEUE_PROCESSORS] })');
    const redis = withQueueArgs(host, getTransport('redis')!, workspaceProfile('deno'));
    const transportFirst = withQueueArgs(
      { ...host, plugins: getTemplate('microservice')!.plugins },
      getTransport('redis')!,
      workspaceProfile('deno'),
    );
    for (const plugins of [
      redis.plugins,
      withPluginOptionSeams(transportFirst.plugins, [JOBS_SEAM]),
    ]) {
      const queue = plugins.find((wiring) => wiring.pkg === 'queue-plugin')!.args!;
      expect(queue).toContain("adapter: 'redis'");
      expect(queue).toContain('processors: [...QUEUE_PROCESSORS]');
      expect(queue).toContain('REDIS_URL');
    }
  });
});

/**
 * Reads one planned file's contents.
 *
 * @param files - The plan
 * @param path - The path to read
 * @returns Its contents
 */
function contentsOf(files: readonly { path: string; contents: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('resolveHost', () => {
  // A bare host also exercises defaults for contributions that no current
  // template omits, keeping the optional host contract independent of the registry.
  it('fills in every optional member of a bare host', () => {
    const resolved = resolveHost(
      { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
      'deno',
    );
    expect(resolved.localImports).toEqual([]);
    expect(resolved.packageImports).toEqual([]);
    expect(resolved.files.map((file) => file.path)).toEqual([]);
    expect(resolved.pluginSpreads).toEqual([]);
    expect(resolved.setupCalls).toEqual([]);
    expect(resolved.appFactory).toBeUndefined();
    expect(resolved.manifest).toBeUndefined();
  });

  it('leaves a factory host plugin list alone', () => {
    const resolved = resolveHost(
      { plugins: [], middleware: [], appFactory: { pkg: 'full-stack-starter', symbol: 'x' } },
      'deno',
    );
    expect(resolved.plugins).toEqual([]);
  });
});

describe('the entry port', () => {
  const host = resolveHost(
    { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
    'deno',
  );

  // A standalone project used to carry the literal `3000` (X4-10), so the `.env`
  // the CLI itself emits could not supply the one value the entry needs — and
  // the first boot on a machine already using 3000 died with `AddrInUse`. It now
  // reads PORT, defaulting to 3000 so a project with no `.env` is unchanged.
  it('reads PORT from the environment, defaulting to 3000', () => {
    const main = contentsOf([...projectFiles('svc', 'deno', host)], 'main.ts');
    expect(main).toContain("await app.start({ port: Number(runtime.env.PORT ?? '3000') });");
  });

  // The read goes through IRuntimeServices, never `Deno.env`/`process.env`:
  // otherwise fixing X4-10 would have reintroduced B1's per-runtime entry on the
  // very line that fixes it.
  it('reads the port portably, with no runtime-specific env API', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      const main = contentsOf([...projectFiles('svc', runtime, host)], 'main.ts');
      expect(main).toContain('const runtime = createRuntimeServices();');
      expect(main).not.toContain('Deno.env');
      expect(main).not.toContain('process.env');
    }
  });

  // A workspace member binds a CLI-allocated port, and that port has to be the
  // same datum its siblings dial — so the entry imports it rather than carrying
  // a literal that could drift from the generated map.
  it('imports the port when one is named', () => {
    const main = contentsOf(
      [
        ...projectFiles('svc', 'deno', host, {
          symbol: 'SERVICE_PORT',
          from: './src/discovery/services.ts',
        }),
      ],
      'main.ts',
    );
    expect(main).toContain(`import { SERVICE_PORT } from './src/discovery/services.ts';`);
    expect(main).toContain('await app.start({ port: SERVICE_PORT });');
    // A member binds the port the CLI allocated it, so it must NOT fall back to
    // the environment: the map and the binding have to stay one datum (M62).
    expect(main).not.toContain('runtime.env.PORT');
    expect(main).not.toContain('3000');
  });

  // Workers has no socket to bind: `start()` takes no port at all, so a port
  // import there would name an identifier nothing reads.
  it('is ignored on the Workers entry, which binds nothing', () => {
    const files = projectFiles('svc', 'cloudflare-workers', host, {
      symbol: 'SERVICE_PORT',
      from: './src/discovery/services.ts',
    });
    expect(files.some((file) => file.path === 'main.ts')).toBe(false);
    expect(contentsOf([...files], 'src/index.ts')).not.toContain('SERVICE_PORT');
  });
});

// The e2e boots a Deno project and signals it for real, which is the only proof
// that matters — but it can only do that for ONE runtime. These pin the other
// three, where the emitted API differs and no gate runs the output at all.
describe('the entry shutdown handler', () => {
  const host = resolveHost(
    { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
    'deno',
  );

  /**
   * Reads the entry a runtime target emits.
   *
   * @param runtime - The target
   * @returns The entry's contents
   */
  function entryFor(runtime: TargetRuntime): string {
    return contentsOf(
      [...projectFiles('svc', runtime, host)],
      runtime === 'cloudflare-workers' ? 'src/index.ts' : 'main.ts',
    );
  }

  // B1: the entry used to render THREE different bodies fixed at `setu new`
  // time, so moving a project between runtimes meant rewriting the file by
  // hand. All three socket targets now emit the same body, through capabilities
  // that already existed.
  it('emits ONE portable body, byte-identical across all three socket targets', () => {
    const deno = entryFor('deno');
    const node = entryFor('node');
    const bun = entryFor('bun');

    expect(node).toBe(deno);
    expect(bun).toBe(deno);
  });

  for (const runtime of ['deno', 'node', 'bun'] as const) {
    it(`catches both signals through IRuntimeServices.onSignal on ${runtime}`, () => {
      const main = entryFor(runtime);
      expect(main).toContain(`for (const signal of ['SIGTERM', 'SIGINT'] as const) {`);
      expect(main).toContain('runtime.onSignal?.(signal, () => {');
      expect(main).toContain('void app.stop()');
      expect(main).toContain('runtime.exit(0)');
      // A rejecting onShutdown hook makes stop() reject; without the catch the
      // process reports an unhandled rejection instead of the reason.
      expect(main).toContain('Graceful shutdown failed');
      expect(main).toContain('runtime.exit(1)');
    });

    // The four touches B1 named, each now absent. `Deno.build.os` in
    // particular: the Windows guard did not move to another branch here, it
    // moved INTO the Deno runtime adapter, which omits `onSignal` entirely on
    // Windows — so the generated project needs no OS check at all.
    it(`reaches no runtime-specific API on ${runtime}`, () => {
      const main = entryFor(runtime);
      expect(main).not.toContain('Deno.build.os');
      expect(main).not.toContain('Deno.addSignalListener');
      expect(main).not.toContain('Deno.exit');
      expect(main).not.toContain('process.on(');
      expect(main).not.toContain('process.exit');
      expect(main).not.toContain('console.error');
    });

    // Shutdown failures used to bypass structured logging entirely. The logger
    // is resolved optionally, so a project scaffolded without LoggerPlugin
    // still shuts down cleanly.
    it(`reports a failed shutdown through the logger on ${runtime}`, () => {
      const main = entryFor(runtime);
      expect(main).toContain('app.services.has(CAPABILITIES.LOGGER)');
      expect(main).toContain("logger?.error('Graceful shutdown failed', { error });");
    });
  }

  for (const runtime of ['node', 'bun'] as const) {
    // `process` is not ambient in TypeScript. Emitting the listener without the
    // declarations makes a generated project's own `tsc` report an undeclared
    // name — the project runs (tsx and Bun both strip types), so nothing but a
    // manifest assertion can catch it. Each target declares the package its own
    // ecosystem prescribes, and `@types/bun` supplies `process` transitively.
    it(`declares the types the ${runtime} listener needs`, () => {
      const expected = runtime === 'node' ? '@types/node' : '@types/bun';
      const manifest = JSON.parse(
        contentsOf([...projectFiles('svc', runtime, host)], 'package.json'),
      ) as { devDependencies?: Record<string, string> };
      expect(manifest.devDependencies?.[expected]).toBeDefined();
    });
  }

  // An isolate is evicted, not signalled: there is no process to catch anything,
  // and `fetch` is the only entry point.
  it('emits nothing on Cloudflare Workers', () => {
    const entry = entryFor('cloudflare-workers');
    expect(entry).not.toContain('SIGTERM');
    // The shutdown handler's own calls. `app.stop()` alone is not the signal:
    // the Workers entry stops a superseded application when bindings change.
    expect(entry).not.toContain('onSignal');
    expect(entry).not.toContain('runtime.exit');
  });
});

// X5-3 / X5-4 / D2. A scaffolded `full-stack` project could not be started by
// following its own README: the Deno target emitted the build command into
// `package.json`, whose script runner a Deno project never invokes, so there was
// no `build` task at all and `deno task start` died on a missing server build.
describe('a template with a frontend build, on a Deno target', () => {
  const host = resolveHost(getTemplate('full-stack')!, 'deno');
  const manifestOf = (runtime: TargetRuntime): Record<string, never> =>
    JSON.parse(contentsOf([...projectFiles('shop', runtime, host)], 'deno.json'));

  it('emits install and build tasks, with start depending on build', () => {
    const tasks = (
      manifestOf('deno') as unknown as {
        tasks: Record<string, string>;
      }
    ).tasks;

    // `--min-dep-age 0` for D1: the project is pinned to the CLI's own version,
    // which on release day is younger than Deno's 24-hour policy allows.
    expect(tasks['install']).toBe('deno install --allow-scripts --min-dep-age 0');
    expect(tasks['build']).toContain('deno task install &&');
    expect(tasks['build']).toContain('npm:@react-router/dev build');
    // The dependency is the point: `deno task start` on a fresh clone has to
    // produce the server build before importing it.
    expect(tasks['start']?.startsWith('deno task build && ')).toBe(true);
  });

  it('sets nodeModulesDir so a COLD checkout type-checks', () => {
    // This template is the one that emits a `package.json` on a Deno target,
    // which switches Deno to node_modules resolution. `apps/full-stack` calls
    // the setting load-bearing; the renderer never emitted it.
    expect(manifestOf('deno')).toMatchObject({ nodeModulesDir: 'auto' });
  });

  it('pins the tooling TypeScript line on every full-stack target (V9-9)', () => {
    // The template's own list is merged AFTER the tooling's, so its old
    // `^5.9.2` silently overrode `~6.0.3` on every npm target. `@react-
    // router/dev@8` accepts TypeScript 6, so one pin serves both.
    for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
      const files = [
        ...projectFiles('shop', runtime, resolveHost(getTemplate('full-stack')!, runtime)),
      ];
      const pkg = JSON.parse(contentsOf(files, 'package.json')) as {
        devDependencies: Record<string, string>;
      };
      expect(pkg.devDependencies['typescript'], runtime).toBe('~6.0.3');
    }
  });

  it('excludes the build and typegen output from fmt and lint, and ignores them', () => {
    const manifest = manifestOf('deno') as unknown as {
      fmt: { exclude?: readonly string[] };
      lint: { exclude?: readonly string[] };
    };
    // `.react-router/` is React Router's typegen directory (V9-11): generated
    // source the project does not own, so it is excluded and ignored exactly
    // like the build.
    expect(manifest.fmt.exclude).toEqual(['build', '.react-router']);
    expect(manifest.lint.exclude).toEqual(['build', '.react-router']);
    const gitignore = contentsOf([...projectFiles('shop', 'deno', host)], '.gitignore');
    expect(gitignore).toContain('build/\n');
    expect(gitignore).toContain('.react-router/\n');
  });

  it('emits a development entry and a dev task that skips the production build', () => {
    const files = [...projectFiles('shop', 'deno', host)];
    const tasks = (manifestOf('deno') as unknown as { tasks: Record<string, string> }).tasks;
    expect(tasks['dev']).toBe('deno task install && deno run -A dev.ts');
    const dev = contentsOf(files, 'dev.ts');
    expect(dev).toContain('viteDevExternals({');
    expect(dev).toContain('packages: [...frameworkPackages, ...workspaceLibraries]');
    expect(dev).toContain('resolve: (specifier) => import.meta.resolve(specifier)');
    expect(dev).toContain("mode: 'development'");
    // The externals list dev.ts imports is the one the server build uses.
    const vite = contentsOf(files, 'vite.config.ts');
    expect(vite).toContain('export const frameworkPackages = [');
    expect(vite).toContain('export const workspaceLibraries: string[] = [];');
  });

  it('hands the development SSR runtime to the plugin in place of assetsDir', () => {
    const config = contentsOf([...projectFiles('shop', 'deno', host)], 'setu.config.ts');
    expect(config).toContain(
      "  ssr?: { serverBuild: unknown } | Pick<ReactRouterPluginOptions, 'loadRequestHandler' | 'mode'>,",
    );
    expect(config).toContain(
      "...(ssr === undefined ? { assetsDir: './build/client/assets' } : ssr),",
    );
    expect(config).toContain(
      "import type { ReactRouterPluginOptions } from '@setu-ts/react-router-plugin';",
    );
  });

  it('emits the same development entry on Node and Bun, run by a dev script', () => {
    const deno = contentsOf([...projectFiles('shop', 'deno', host)], 'dev.ts');
    for (const [runtime, dev] of [
      ['node', 'tsx dev.ts'],
      ['bun', 'bun run dev.ts'],
    ] as const) {
      const files = [
        ...projectFiles('shop', runtime, resolveHost(getTemplate('full-stack')!, runtime)),
      ];
      expect(contentsOf(files, 'dev.ts')).toBe(deno);
      const scripts = (
        JSON.parse(contentsOf(files, 'package.json')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      expect(scripts['start:dev']).toBe(dev);
      expect(contentsOf(files, 'README.md')).toContain(
        runtime === 'bun' ? '```bash\nbun run start:dev\n```' : '```bash\nnpm run start:dev\n```',
      );
      // `ssr` is read on these targets, not underscore-prefixed.
      expect(contentsOf(files, 'setu.config.ts')).toContain(
        "...(ssr === undefined ? { assetsDir: './build/client/assets' } : ssr),",
      );
    }
  });

  it('emits no development entry on Workers', () => {
    const workersHost = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const files = [...projectFiles('shop', 'cloudflare-workers', workersHost)];
    expect(files.some((file) => file.path === 'dev.ts')).toBe(false);
    const workers = contentsOf(files, 'setu.config.ts');
    // One signature on every target; on Workers the entry supplies the compiled
    // server build, so the parameter is READ (M113d §3.10) and the arm is
    // chosen at runtime.
    expect(workers).toContain(
      "  ssr?: { serverBuild: unknown } | Pick<ReactRouterPluginOptions, 'loadRequestHandler' | 'mode'>,",
    );
    expect(workers).toContain("'serverBuild' in ssr");
    const scripts = (
      JSON.parse(contentsOf(files, 'package.json')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['dev']).not.toContain('dev.ts');
  });

  it('leaves a template WITHOUT a frontend build untouched', () => {
    // The three settings above ride one signal, so a REST project must gain
    // none of them — a `package.json` in a Deno project is the trap M58 hit.
    const rest = resolveHost(getTemplate('rest')!, 'deno');
    const manifest = JSON.parse(
      contentsOf([...projectFiles('svc', 'deno', rest)], 'deno.json'),
    ) as { tasks: Record<string, string>; nodeModulesDir?: string; lint?: unknown };

    expect(manifest.tasks['build']).toBeUndefined();
    expect(manifest.tasks['install']).toBeUndefined();
    // But it DOES get a `test` task: `setu generate module` emits a
    // `*.service.test.ts` into every host, and no template ran it (A3).
    expect(manifest.tasks['test']).toBe("deno test -A --ignore='**/*.e2e.test.ts'");
    // Every Deno project links node_modules since 0.9, so the Node-hosted CLI
    // can import its config; that is the only one of the three it gains.
    expect(manifest.nodeModulesDir).toBe('auto');
    expect(manifest.lint).toBeUndefined();
  });
});

// Group C. Every one of these is a generated file sitting outside a path the
// project itself runs — the shape the whole workstream shares.
describe('the Cloudflare Workers target', () => {
  const micro = resolveHost(getTemplate('microservice')!, 'cloudflare-workers');
  const rest = resolveHost(getTemplate('rest')!, 'cloudflare-workers');
  const filesOf = (host: ReturnType<typeof resolveHost>) => [
    ...projectFiles('edge', 'cloudflare-workers', host),
  ];

  it('imports waitUntil in the ENTRY and threads it into the factory (X9-1)', () => {
    const entry = contentsOf(filesOf(micro), 'src/index.ts');

    expect(entry).toContain("import { waitUntil } from 'cloudflare:workers';");
    expect(entry).toContain('createApp(env, waitUntil)');
  });

  it('keeps the platform specifier OUT of setu.config.ts', () => {
    // `setu commands` loads that module under Deno, which cannot resolve
    // `cloudflare:workers` at all — putting the import there, which is what the
    // plugin README's only usage example shows, breaks the CLI outright.
    const config = contentsOf(filesOf(micro), 'setu.config.ts');

    // The IMPORT is the property, not the word: the JSDoc names the specifier
    // deliberately, to say why the parameter arrives from the entry.
    expect(config).not.toContain("from 'cloudflare:workers'");
    expect(config).toContain('waitUntil?: (promise: Promise<unknown>) => void');
    expect(config).toContain('...(waitUntil ? { waitUntil } : {})');
  });

  it('declares the waitUntil parameter underscore-prefixed for a host that consumes none (M113d §3.8)', () => {
    // The entry always passes the platform sink positionally, so the parameter
    // is declared on every Workers project — but underscore-prefixed where
    // nothing reads it, so the generated project passes its own lint.
    const config = contentsOf(filesOf(rest), 'setu.config.ts');
    const entry = contentsOf(filesOf(rest), 'src/index.ts');

    expect(config).toContain('_waitUntil?: (promise: Promise<unknown>) => void');
    expect(config).not.toContain('...(_waitUntil');
    expect(entry).toContain("import { waitUntil } from 'cloudflare:workers';");
    expect(entry).toContain('createApp(env, waitUntil)');
  });

  it('starts with deno serve, which actually binds (X9-7)', () => {
    // `deno run` on a `fetch` default export binds nothing and exits 0, so a CI
    // step and a developer's first instinct both read as success.
    const manifest = JSON.parse(contentsOf(filesOf(rest), 'deno.json')) as {
      tasks: Record<string, string>;
    };
    expect(manifest.tasks['start']?.startsWith('deno serve ')).toBe(true);
  });

  it('ships a type-check path, which the target had none of (X9-4)', () => {
    const pkg = JSON.parse(contentsOf(filesOf(rest), 'package.json')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // `wrangler` bundles with esbuild, which strips types without checking them,
    // and `deno check` types `cloudflare:workers` as `any` — so the README's own
    // Durable Object snippet failed under the only checker present.
    expect(pkg.scripts['check']).toBe('tsc --noEmit && setu check');
    expect(pkg.devDependencies['typescript']).toBeDefined();
    expect(pkg.devDependencies['@cloudflare/workers-types']).toBeDefined();
  });

  it('builds before type-checking a Workers project with an npm build (V9-9)', () => {
    // The Workers entry imports the compiled server build, which does not exist
    // until the build runs; `tsc` cannot declare a relative module ambiently
    // (TS2436), so the check script itself has to build first.
    const fullStack = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const fullStackPkg = JSON.parse(
      contentsOf([...projectFiles('edge', 'cloudflare-workers', fullStack)], 'package.json'),
    ) as { scripts: Record<string, string> };
    expect(fullStackPkg.scripts['check']).toBe('npm run build && tsc --noEmit && setu check');

    // A rest Worker imports no build output, so its check stays the bare one.
    const restPkg = JSON.parse(contentsOf(filesOf(rest), 'package.json')) as {
      scripts: Record<string, string>;
    };
    expect(restPkg.scripts['check']).toBe('tsc --noEmit && setu check');
  });

  it("ignores the frontend toolchain's generated directories (V9-11)", () => {
    // Workers is the npm-manifest path that emits ESLint and Prettier configs,
    // so the full-stack typegen directory has to reach them here as well as
    // Deno's fmt/lint excludes.
    const fullStack = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const files = [...projectFiles('edge', 'cloudflare-workers', fullStack)];
    expect(contentsOf(files, 'eslint.config.js')).toContain(`'.react-router/'`);
    expect(contentsOf(files, '.prettierignore')).toContain('.react-router/');
  });

  it('pins wrangler and workers-types as a set whose peer ranges intersect', () => {
    const pkg = JSON.parse(contentsOf(filesOf(rest), 'package.json')) as {
      devDependencies: Record<string, string>;
    };

    // Measured: wrangler 4.148.0 declares peerOptional
    // `@cloudflare/workers-types@^5.20261006.1`, and the `^4.0.0` wrangler range
    // beside a `^4.x` types pin made `npm install` fail with ERESOLVE on every
    // new Workers project. A floating `^4` is refused because wrangler moved
    // that peer's MAJOR inside its own 4.x line; the guarded npm install in
    // `workers-install-e2e.test.ts` is what proves the set resolves.
    expect(pkg.devDependencies['wrangler']).toBe('~4.148.0');
    expect(pkg.devDependencies['@cloudflare/workers-types']).toBe('^5.20261006.1');
  });

  it('emits a tsconfig the generated check script can pass (X9-4)', () => {
    const tsconfig = JSON.parse(contentsOf(filesOf(rest), 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
    };

    // Every emitted import carries `.ts`, which tsc refuses (TS5097) without
    // `allowImportingTsExtensions`, which in turn requires `noEmit`. And the
    // types package is not `@types/*`, so tsc loads it only when named — before
    // this it was installed and read by nothing.
    expect(tsconfig.compilerOptions['allowImportingTsExtensions']).toBe(true);
    expect(tsconfig.compilerOptions['noEmit']).toBe(true);
    expect(tsconfig.compilerOptions['types']).toEqual(['@cloudflare/workers-types', 'node']);
    expect(tsconfig.compilerOptions['lib']).toEqual(['ES2022']);
  });

  it("keeps a template's own types and lib beside the Workers ones", () => {
    const fullStack = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const tsconfig = JSON.parse(contentsOf(filesOf(fullStack), 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
    };

    // `node` because the same tsconfig type-checks the emitted `vite.config.ts`,
    // which imports `node:fs` (V9-9).
    expect(tsconfig.compilerOptions['types']).toEqual([
      '@cloudflare/workers-types',
      'node',
      'vite/client',
    ]);
    expect(tsconfig.compilerOptions['lib']).toEqual(['DOM', 'DOM.Iterable', 'ES2022']);
    // The Workers entry imports the compiled server build, which has no
    // declarations; `allowJs` is what lets `tsc --noEmit` read it after a build.
    expect(tsconfig.compilerOptions['allowJs']).toBe(true);
  });

  it('declares @types/node for every Workers project (V9-9, V10-23)', () => {
    const fullStack = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const pkg = JSON.parse(
      contentsOf([...projectFiles('edge', 'cloudflare-workers', fullStack)], 'package.json'),
    ) as {
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies['@types/node']).toBe('^24.0.0');
    // V10-23: a Workers project with no npm build now emits tests too, so it
    // needs the Node declarations and the `tsx` runner regardless of a build.
    const rest = resolveHost(getTemplate('rest')!, 'cloudflare-workers');
    const restPkg = JSON.parse(
      contentsOf([...projectFiles('edge', 'cloudflare-workers', rest)], 'package.json'),
    ) as {
      devDependencies: Record<string, string>;
    };
    expect(restPkg.devDependencies['@types/node']).toBe('^24.0.0');
    expect(restPkg.devDependencies['tsx']).toBe('^4.20.0');
    expect(restPkg.devDependencies['@cloudflare/workers-types']).toBeDefined();
  });

  it('adds no build ignores where the Workers template has no npm build', () => {
    const rest = resolveHost(getTemplate('rest')!, 'cloudflare-workers');
    const files = [...projectFiles('edge', 'cloudflare-workers', rest)];
    const tsconfig = JSON.parse(contentsOf(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
    };

    expect(tsconfig.compilerOptions['types']).toEqual(['@cloudflare/workers-types', 'node']);
    expect(tsconfig.compilerOptions['allowJs']).toBeUndefined();
    expect(contentsOf(files, 'eslint.config.js')).not.toContain("'build/'");
    expect(contentsOf(files, '.prettierignore')).not.toContain('build/');
  });

  it('ignores only the build output when an npm build declares no generated dirs', () => {
    // `generatedDirs` is optional so a future toolchain that writes nothing
    // beside its build needs no entry; one ignore list must still carry the
    // build itself.
    const fullStack = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
    const manifest = fullStack.manifest;
    expect(manifest?.npmBuild).toBeDefined();
    if (manifest?.npmBuild === undefined) return;
    const { generatedDirs: _generated, ...npmBuild } = manifest.npmBuild;
    const host = { ...fullStack, manifest: { ...manifest, npmBuild } };
    const files = [...projectFiles('edge', 'cloudflare-workers', host)];

    expect(contentsOf(files, 'eslint.config.js')).toContain(`'build/'`);
    expect(contentsOf(files, 'eslint.config.js')).not.toContain(`'.react-router/'`);
    expect(contentsOf(files, '.prettierignore')).toContain('build/');
    expect(contentsOf(files, '.prettierignore')).not.toContain('.react-router/');
  });

  it('dispatches a single queue directly instead of routing on its name', () => {
    // The generated Worker handles one queue without a `switch`; a second queue
    // is what makes routing necessary. Both shapes must stay correct because a
    // template may declare either.
    const microservice = resolveHost(getTemplate('microservice')!, 'cloudflare-workers');
    const [worker] = microservice.workerExports;
    expect(worker).toBeDefined();
    if (worker === undefined) return;
    const [route] = worker.routes;
    expect(route).toBeDefined();
    if (route === undefined) return;
    const host = { ...microservice, workerExports: [{ ...worker, routes: [route] }] };
    const entry = contentsOf([...projectFiles('edge', 'cloudflare-workers', host)], 'src/index.ts');

    expect(entry).toContain(`await ${route.symbol}(app)(payload);`);
    expect(entry).not.toContain(`case '${route.queueName}':`);
  });

  it('leaves the tsconfig of every other npm target unchanged', () => {
    const node = resolveHost(getTemplate('rest')!, 'node');
    const tsconfig = JSON.parse(
      contentsOf([...projectFiles('edge', 'node', node)], 'tsconfig.json'),
    ) as { compilerOptions: Record<string, unknown> };

    // Only the runtime's own types: TypeScript 6 includes no `@types` package
    // unless `types` names it, and none of the Workers declarations leak in.
    expect(tsconfig.compilerOptions['types']).toEqual(['node']);
    expect(tsconfig.compilerOptions['lib']).toBeUndefined();
  });

  it('documents every binding type the plugin reads (X9-9)', () => {
    const toml = contentsOf(filesOf(rest), 'wrangler.toml');

    // Two of seven before this: a developer standing up the platform surface
    // had to hand-edit three files against three separate README sections.
    for (const stanza of [
      '[[kv_namespaces]]',
      '[[r2_buckets]]',
      '[[d1_databases]]',
      '[[queues.producers]]',
      '[[queues.consumers]]',
      '[[durable_objects.bindings]]',
      '[triggers]',
    ]) {
      expect(toml).toContain(stanza);
    }
    // The two facts a reader cannot infer from the stanza alone.
    expect(toml).toContain('max_batch_timeout = 0');
    expect(toml).toContain('EXPORTED from your own src/index.ts');
  });
});

describe('a standalone README transport note', () => {
  it('renders a transport note and re-wraps it to the emitted width (V9-17)', () => {
    // The text comes from `TransportSpec.connection.note`, carried onto the host
    // by the broker overlay. A standalone project has no spec at render time, so
    // the host is the only source. The note is LONGER than one line so the
    // programmatic re-wrap is what makes the project pass its own fmt --check.
    const note =
      'Every topic published through NATS must start with `app.`. The broker creates its ' +
      '`MESSAGING` stream with the subjects `app.>`, `rr.req.app.>` and `rr.inbox.>` on first ' +
      'start, and uses a pre-existing stream exactly as it is.';
    const host = resolveHost(getTemplate('microservice')!, 'deno');
    const files = projectFiles('svc', 'deno', {
      ...host,
      files: [...host.files, { path: BROKER_COMPOSE_FILE, contents: '' }],
      transportNotes: [note],
    });
    const readme = contentsOf([...files], 'README.md');

    expect(readme).toContain('## Local transport services');
    expect(readme).toContain('must start with `app.`');
    expect(readme).toContain('`MESSAGING`');
    // `deno fmt` reflows at 100 columns; a hand-broken paragraph authored around
    // a shorter line would fail the scaffold's own check.
    for (const line of readme.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('the routes a generated README lists', () => {
  // Measured by booting each template and requesting every path; the scaffold
  // e2e re-checks the list against a running project on every run.
  const PLUGIN_PATHS = ['/health', '/live', '/ready', '/metrics', '/docs', '/openapi.json'];
  const pathsOf = (name: string | undefined, runtime: TargetRuntime = 'deno') =>
    servedRoutes(resolveHost(name === undefined ? MINIMAL_HOST : getTemplate(name)!, runtime)).map(
      (route) => route.path,
    );

  it('lists only the hello-world route for the template-less host', () => {
    expect(pathsOf(undefined)).toEqual(['/']);
  });

  it('lists the greeting showcase and the plugin endpoints for rest, in either style', () => {
    const expected = ['/', '/greetings', '/greetings/:name', ...PLUGIN_PATHS];
    expect(pathsOf('rest')).toEqual(expected);
    expect(pathsOf('class-based')).toEqual(expected);
  });

  it('lists no showcase for microservice, which emits none', () => {
    expect(pathsOf('microservice')).toEqual(['/', ...PLUGIN_PATHS]);
  });

  it('lists what the full-stack starter composes, though its plugin list is empty', () => {
    // The factory hides HealthPlugin, MetricsPlugin and OpenApiPlugin from the
    // wirings, so only its `composes` declaration can put them here.
    expect(resolveHost(getTemplate('full-stack')!, 'deno').plugins).toEqual([]);
    expect(pathsOf('full-stack')).toEqual(['/', '/products', '/login', ...PLUGIN_PATHS]);
  });

  it('keeps the list after a runtime swap', () => {
    expect(pathsOf('microservice', 'cloudflare-workers')).toEqual(['/', ...PLUGIN_PATHS]);
  });

  it('writes the section into the README with the address for each runtime', () => {
    const readme = (runtime: TargetRuntime) =>
      projectFiles('proj', runtime, resolveHost(getTemplate('rest')!, runtime)).find(
        (f) => f.path === 'README.md',
      )?.contents ?? '';
    expect(readme('deno')).toContain('## What it serves\n\nAt `http://localhost:3000`');
    expect(readme('node')).toContain('- `/docs` — Swagger UI for the API');
    expect(readme('cloudflare-workers')).toContain(
      'Under `npx wrangler dev`, at `http://localhost:8787`',
    );
  });

  it('names the allocated port for a workspace member', () => {
    const files = projectFiles('proj', 'deno', resolveHost(getTemplate('rest')!, 'deno'), {
      symbol: 'SERVICE_PORT',
      from: './src/discovery/services.ts',
    });
    const readme = files.find((f) => f.path === 'README.md')?.contents ?? '';
    expect(readme).toContain('On the port `./src/discovery/services.ts` exports:');
  });
});

describe('the emitted smoke test', () => {
  const smokeTest = (name: string, runtime: TargetRuntime = 'deno') =>
    contentsOf(
      [...projectFiles('proj', runtime, resolveHost(getTemplate(name)!, runtime))],
      'test/app.test.ts',
    );

  // I2 (X66-3): `/health` stays 200 when `populateLoadContext` throws, so the
  // full-stack smoke test also requests the SSR home page — through `fetch`,
  // since an SSR body streams and `inject()` refuses one, with the body
  // consumed so the test's resource sanitizer does not report a leak.
  it('requests the SSR home page through fetch for full-stack, beside /health', () => {
    const test = smokeTest('full-stack');
    expect(test).toContain("url: '/health'");
    expect(test).toContain("app.fetch(new Request('http://localhost/'))");
    expect(test).toContain('await page.text();');
  });

  it('keeps the /health-only smoke test for a host without a factory', () => {
    const test = smokeTest('rest');
    expect(test).toContain("url: '/health'");
    expect(test).not.toContain('app.fetch');
  });

  // The emitted test runs on all three runtimes through testHarnessFor, so the
  // fetch assertion must render in each target's own idiom.
  it('renders the fetch assertion in each runtime idiom', () => {
    expect(smokeTest('full-stack', 'node')).toContain('assert.deepStrictEqual(page.status, 200);');
    expect(smokeTest('full-stack', 'bun')).toContain('expect(page.status).toEqual(200);');
    expect(smokeTest('full-stack', 'deno')).toContain('expect(page.status).toEqual(200);');
  });
});

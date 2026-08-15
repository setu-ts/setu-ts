import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import type { TargetRuntime } from '../../../src/constants.ts';
import { getTemplate } from '../../../src/templates/registry.ts';

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
  // Every host in the registry declares `localImports` and `files`, so these
  // fallbacks are unreachable through `runNewCommand`. They are not dead —
  // `TemplateHost` declares both optional — so they are driven here directly
  // rather than left as an untested path behind a template that happens not to
  // exercise them.
  it('fills in every optional member of a bare host', () => {
    const resolved = resolveHost(
      { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
      'deno',
    );
    expect(resolved.localImports).toEqual([]);
    expect(resolved.packageImports).toEqual([]);
    expect(resolved.files).toEqual([]);
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
      [...projectFiles('svc', 'deno', host, {
        symbol: 'SERVICE_PORT',
        from: './src/discovery/services.ts',
      })],
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
    expect(entry).not.toContain('app.stop()');
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
    const tasks = (manifestOf('deno') as unknown as {
      tasks: Record<string, string>;
    }).tasks;

    expect(tasks['install']).toBe('deno install --allow-scripts');
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

  it('excludes the build output from fmt and lint, and ignores it', () => {
    const manifest = manifestOf('deno') as unknown as {
      fmt: { exclude?: readonly string[] };
      lint: { exclude?: readonly string[] };
    };
    expect(manifest.fmt.exclude).toEqual(['build']);
    expect(manifest.lint.exclude).toEqual(['build']);
    expect(contentsOf([...projectFiles('shop', 'deno', host)], '.gitignore')).toContain('build/\n');
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
    expect(manifest.nodeModulesDir).toBeUndefined();
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

  it('emits no waitUntil parameter for a host that consumes none', () => {
    // Otherwise a REST project on Workers gains an unused parameter, which its
    // own type-check rejects.
    const config = contentsOf(filesOf(rest), 'setu.config.ts');
    const entry = contentsOf(filesOf(rest), 'src/index.ts');

    expect(config).not.toContain('waitUntil');
    expect(entry).not.toContain('cloudflare:workers');
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
    expect(pkg.scripts['check']).toBe('tsc --noEmit');
    expect(pkg.devDependencies['typescript']).toBeDefined();
    expect(pkg.devDependencies['@cloudflare/workers-types']).toBeDefined();
  });

  it('documents every binding type the plugin reads (X9-9)', () => {
    const toml = contentsOf(filesOf(rest), 'wrangler.toml');

    // Two of seven before this: a developer standing up the platform surface
    // had to hand-edit three files against three separate README sections.
    for (
      const stanza of [
        '[[kv_namespaces]]',
        '[[r2_buckets]]',
        '[[d1_databases]]',
        '[[queues.producers]]',
        '[[queues.consumers]]',
        '[[durable_objects.bindings]]',
        '[triggers]',
      ]
    ) {
      expect(toml).toContain(stanza);
    }
    // The two facts a reader cannot infer from the stanza alone.
    expect(toml).toContain('max_batch_timeout = 0');
    expect(toml).toContain('EXPORTED from your own src/index.ts');
  });
});

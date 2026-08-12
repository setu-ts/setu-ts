import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import type { TargetRuntime } from '../../../src/constants.ts';

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

  // The startup half is asserted byte-for-byte because a standalone project's
  // entry must not change shape when a member's does. The shutdown half follows
  // it and is asserted separately below.
  it('binds a literal 3000 with no port import', () => {
    const main = contentsOf([...projectFiles('svc', 'deno', host)], 'main.ts');
    expect(main.startsWith(
      `import { createApp } from './setu.config.ts';\n` +
        `\n` +
        `const app = await createApp();\n` +
        `\n` +
        `await app.start({ port: 3000 });\n`,
    )).toBe(true);
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

  // Deno throws on `addSignalListener('SIGTERM')` under Windows, so the guard is
  // load-bearing rather than defensive: without it a scaffolded project would
  // crash at startup there.
  it('catches both signals through Deno.addSignalListener, guarded for Windows', () => {
    const main = entryFor('deno');
    expect(main).toContain(`if (Deno.build.os !== 'windows') {`);
    expect(main).toContain(`for (const signal of ['SIGTERM', 'SIGINT'] as const) {`);
    expect(main).toContain('Deno.addSignalListener(signal, () => {');
    expect(main).toContain('void app.stop()');
    expect(main).toContain('Deno.exit(0)');
    // A rejecting onShutdown hook makes stop() reject; without the catch the
    // process reports an unhandled rejection instead of the reason.
    expect(main).toContain('Graceful shutdown failed:');
    expect(main).toContain('Deno.exit(1)');
  });

  for (const runtime of ['node', 'bun'] as const) {
    it(`catches both signals through process.on on ${runtime}`, () => {
      const main = entryFor(runtime);
      expect(main).toContain(`for (const signal of ['SIGTERM', 'SIGINT'] as const) {`);
      expect(main).toContain('process.on(signal, () => {');
      expect(main).toContain('void app.stop()');
      expect(main).toContain('process.exit(0)');
      expect(main).toContain('process.exit(1)');
      // No OS guard on this path: `process.on` for a signal the platform never
      // raises is a no-op rather than a throw.
      expect(main).not.toContain('Deno.build.os');
    });

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

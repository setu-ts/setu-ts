import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';

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
      { di: false },
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

  it('applies --di to a plugin-list host', () => {
    const resolved = resolveHost(
      { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
      { di: true },
      'deno',
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
      'deno',
    );
    expect(resolved.plugins).toEqual([]);
  });
});

describe('the entry port', () => {
  const host = resolveHost(
    { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
    { di: false },
    'deno',
  );

  // The default is what every scaffolded project emitted before workspaces
  // existed, asserted byte-for-byte because a standalone project's entry must
  // not change shape when a member's does.
  it('binds a literal 3000 with no port import', () => {
    const main = contentsOf([...projectFiles('svc', 'deno', host, { di: false })], 'main.ts');
    expect(main).toBe(
      `import { createApp } from './setu.config.ts';\n` +
        `\n` +
        `const app = await createApp();\n` +
        `\n` +
        `await app.start({ port: 3000 });\n`,
    );
  });

  // A workspace member binds a CLI-allocated port, and that port has to be the
  // same datum its siblings dial — so the entry imports it rather than carrying
  // a literal that could drift from the generated map.
  it('imports the port when one is named', () => {
    const main = contentsOf(
      [...projectFiles('svc', 'deno', host, { di: false }, {
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
    const files = projectFiles('svc', 'cloudflare-workers', host, { di: false }, {
      symbol: 'SERVICE_PORT',
      from: './src/discovery/services.ts',
    });
    expect(files.some((file) => file.path === 'main.ts')).toBe(false);
    expect(contentsOf([...files], 'src/index.ts')).not.toContain('SERVICE_PORT');
  });
});

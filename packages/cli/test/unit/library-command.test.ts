import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runLibraryCommand } from '../../src/commands/library.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from '../../src/workspace/manifest.ts';
import { LIBS_GLOB } from '../../src/workspace/library.ts';
import { ROOT_MANIFEST } from '../../src/workspace/root-manifest.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

/**
 * Builds a harness over a workspace at `/acme`.
 *
 * The directory name matters: the library's scope is derived from it, so a test
 * that used `/ws` would assert a scope no real workspace would produce.
 *
 * @param root - The root manifest contents, or `undefined` for none at all
 * @param workspace - Whether the workspace manifest exists
 * @returns The harness
 */
function harness(root?: string, workspace = true): Harness {
  const seed: Record<string, string> = {};
  if (workspace) {
    seed[`/acme/${WORKSPACE_MANIFEST}`] = renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: [],
    });
    seed[`/acme/${ROOT_MANIFEST}`] = root ??
      `${JSON.stringify({ workspace: ['./apps/*', LIBS_GLOB] }, null, 2)}\n`;
  }
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runLibraryCommand(parseArgs(argv), { fs, dir: '/acme', log: out.sink, error: err.sink }),
  };
}

describe('runLibraryCommand', () => {
  it('prints its usage under --help and exits 0', async () => {
    const h = harness();
    expect(await h.run(['library', '--help'])).toBe(0);
    expect(h.out.text()).toContain('generate library <name>');
  });

  it('refuses a missing name', async () => {
    const h = harness();
    expect(await h.run(['library'])).toBe(2);
    expect(h.err.text()).toContain('generate library <name>');
  });

  it('refuses a name that cannot form an identifier', async () => {
    const h = harness();
    expect(await h.run(['library', '2fa'])).toBe(2);
    expect(h.err.text()).toContain('must not start with a digit');
    expect(h.fs.writes).toEqual([]);
  });

  // A library is resolved BY THE WORKSPACE, so outside one the directory would be
  // unreachable by any name.
  it('refuses outside a workspace, naming how to make one', async () => {
    const h = harness(undefined, false);
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain(WORKSPACE_MANIFEST);
    expect(h.err.text()).toContain('--workspace');
    expect(h.fs.writes).toEqual([]);
  });

  it('creates the library under libs/, with a barrel and a test', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared'])).toBe(0);
    expect(h.fs.writes).toContain('/acme/libs/shared/deno.json');
    expect(h.fs.writes).toContain('/acme/libs/shared/src/index.ts');
    expect(h.fs.writes).toContain('/acme/libs/shared/test/shared.test.ts');
  });

  // Both fields are what make a sibling's `import '@acme/shared'` resolve — a
  // member declaring `name` without `exports` warns and resolves nothing. Proven
  // for real in the e2e, which type-checks a member that imports one.
  it('declares the name and exports the workspace resolves it by', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared'])).toBe(0);
    const manifest = JSON.parse(h.fs.read('/acme/libs/shared/deno.json')) as {
      name?: string;
      exports?: Record<string, string>;
    };
    // Scoped on the workspace directory, not on the library name alone.
    expect(manifest.name).toBe('@acme/shared');
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
  });

  it('honours an explicit --scope, with or without the @', async () => {
    for (const flag of ['acme-corp', '@acme-corp']) {
      const h = harness();
      expect(await h.run(['library', 'shared', '--scope', flag])).toBe(0);
      const manifest = JSON.parse(h.fs.read('/acme/libs/shared/deno.json')) as { name?: string };
      expect(manifest.name).toBe('@acme-corp/shared');
    }
  });

  it('refuses --scope with no value', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared', '--scope'])).toBe(2);
    expect(h.err.text()).toContain('--scope needs a value');
    expect(h.fs.writes).toEqual([]);
  });

  // A workspace this CLI created declares both globs already, so the common path
  // must leave the root completely alone.
  it('leaves a root that already declares the libs glob untouched', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared'])).toBe(0);
    expect(h.fs.writes).not.toContain(`/acme/${ROOT_MANIFEST}`);
  });

  // Without the glob Deno does not treat the directory as a member, so every
  // `import '@acme/shared'` fails to resolve with nothing pointing at the cause.
  it('adds the libs glob to a root created before libraries existed', async () => {
    const h = harness(`${JSON.stringify({ workspace: ['./apps/*'], tasks: { dev: 'x' } })}\n`);
    expect(await h.run(['library', 'shared'])).toBe(0);
    const root = JSON.parse(h.fs.read(`/acme/${ROOT_MANIFEST}`)) as {
      workspace?: string[];
      tasks?: Record<string, string>;
    };
    expect(root.workspace).toEqual(['./apps/*', LIBS_GLOB]);
    // A one-key merge, not a regeneration: whatever else the root held survives.
    expect(root.tasks).toEqual({ dev: 'x' });
  });

  it('refuses a root whose workspace key is not a list of globs', async () => {
    const h = harness(`${JSON.stringify({ workspace: 'apps/*' })}\n`);
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain('list');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a root it cannot parse rather than rewriting it', async () => {
    const h = harness('{ "workspace": ["./apps/*"], // comment\n}');
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain('by hand');
    expect(h.fs.writes).toEqual([]);
  });

  it('writes nothing under --dry-run but prints the whole plan', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared', '--dry-run'])).toBe(0);
    expect(h.fs.writes).toEqual([]);
    expect(h.out.text()).toContain('would create /acme/libs/shared/src/index.ts');
  });

  it('refuses when the library already has files on disk', async () => {
    const h = harness();
    h.fs.writeFile('/acme/libs/shared/src/index.ts', new TextEncoder().encode('mine'));
    const before = h.fs.writes.length;
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain('Refusing to overwrite');
    expect(h.fs.writes.length).toBe(before);
  });

  it('tells the caller how to import what it just created', async () => {
    const h = harness();
    expect(await h.run(['library', 'shared'])).toBe(0);
    expect(h.out.text()).toContain(`import { shared } from '@acme/shared';`);
  });
});

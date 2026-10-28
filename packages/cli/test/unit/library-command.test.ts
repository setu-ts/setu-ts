import { describe, expect, it } from 'vitest';
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
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import type { TargetRuntime } from '../../src/constants.ts';

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
function harness(root?: string, workspace = true, runtime: TargetRuntime = 'deno'): Harness {
  const seed: Record<string, string> = {};
  if (workspace) {
    seed[`/acme/${WORKSPACE_MANIFEST}`] = renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime,
      basePort: 3000,
      transport: 'http',
      members: [],
    });
    const profile = workspaceProfile(runtime);
    seed[`/acme/${profile.rootManifestFile}`] =
      root ??
      `${JSON.stringify(
        { [profile.globKey]: [profile.memberGlob('apps'), profile.memberGlob('libs')] },
        null,
        2,
      )}\n`;
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
  it('plans missing Bun linker configuration, preserves hoisted settings and refuses other TOML', async () => {
    for (const setting of [
      undefined,
      '[install]\nlinker = "hoisted"\n',
      '[install]\nlinker = "isolated"\n',
      '[install]\ncache = true\n',
    ]) {
      const h = harness(undefined, true, 'bun');
      if (setting !== undefined)
        await h.fs.writeFile('/acme/bunfig.toml', new TextEncoder().encode(setting));
      const before = [...h.fs.writes];
      const refused = setting !== undefined && !setting.includes('hoisted');
      expect(await h.run(['library', 'shared', '--dry-run'])).toBe(refused ? 1 : 0);
      expect(h.fs.writes).toEqual(before);
      expect(await h.run(['library', 'shared'])).toBe(refused ? 1 : 0);
      if (refused) {
        expect(h.err.text()).toContain('linker = "hoisted"');
        expect(h.fs.writes).toEqual(before);
      } else {
        expect(h.fs.read('/acme/bunfig.toml')).toBe('[install]\nlinker = "hoisted"\n');
      }
    }
  });
  it('refuses an unreadable bunfig.toml with a named error instead of throwing (M120 re-audit N1)', async () => {
    // A directory stands in for every unreadable shape (a link, >1 MiB, a special
    // file): each makes the bounded read throw, which once escaped as a stack.
    const h = harness(undefined, true, 'bun');
    await h.fs.mkdir('/acme/bunfig.toml', { recursive: true });
    const before = [...h.fs.writes];
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain('/acme/bunfig.toml: expected a regular file at most 1 MiB');
    expect(h.fs.writes).toEqual(before);
  });
  it('dry-run collision refuses without writing', async () => {
    const h = harness();
    await h.fs.writeFile('/acme/libs/widget/src/index.ts', new TextEncoder().encode('mine'));
    const writes = [...h.fs.writes];
    expect(await h.run(['library', 'widget', '--dry-run'])).toBe(1);
    expect(h.err.text()).toContain('WOULD REFUSE: /acme/libs/widget/src/index.ts already exists');
    expect(h.fs.writes).toEqual(writes);
  });
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

  // The library writes `test/<kebab>.test.ts`, so a name within the 255-byte
  // kebab bound still plans an over-long file name — refused before any write.
  it('refuses a name whose planned test file exceeds 255 bytes', async () => {
    const h = harness();
    expect(await h.run(['library', 'a'.repeat(250)])).toBe(2);
    expect(h.err.text()).toContain('255 bytes');
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

  // Measured on a real npm workspace: immediately after this command
  // `node_modules/@acme` does not exist, and the import printed above fails to
  // resolve until an install links the package. Deno needs nothing — it resolves a
  // member from the manifest glob — so the line appears only where it is true.
  it('says to re-install on npm and Bun, where the link is made by the install', async () => {
    for (const [runtime, command] of [
      ['node', 'npm install'],
      ['bun', 'bun install'],
    ] as const) {
      const h = harness(undefined, true, runtime);
      expect(await h.run(['library', 'shared'])).toBe(0);
      expect(h.out.text()).toContain(command);
    }

    const deno = harness();
    expect(await deno.run(['library', 'shared'])).toBe(0);
    expect(deno.out.text()).not.toContain('install');
  });
});

it('rolls back a failed library write and reports scalar and Error failures', async () => {
  for (const cause of ['disk refused', new Error('disk refused')]) {
    const h = harness();
    h.fs.writeFile = () => Promise.reject(cause);
    expect(await h.run(['library', 'shared'])).toBe(1);
    expect(h.err.text()).toContain('Failed to write: disk refused');
  }
});

it('honors an already interrupted library command before the first write', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  expect(
    await runLibraryCommand(parseArgs(['library', 'shared']), {
      fs: h.fs,
      dir: '/acme',
      log: h.out.sink,
      error: h.err.sink,
      interrupt: controller.signal,
    }),
  ).toBe(130);
  expect(h.fs.writes).toEqual([]);
  expect(h.err.text()).toContain('Interrupted');
});

it('uses the workspace scope fallback for a root workspace directory', async () => {
  const original = harness();
  const seed = {
    [`/${WORKSPACE_MANIFEST}`]: original.fs.read(`/acme/${WORKSPACE_MANIFEST}`),
    '/deno.json': original.fs.read('/acme/deno.json'),
  };
  const fs = createFakeFs(seed);
  expect(
    await runLibraryCommand(parseArgs(['library', 'shared', '--dry-run']), {
      fs,
      dir: '/',
      log: original.out.sink,
      error: original.err.sink,
    }),
  ).toBe(0);
  expect(original.out.text()).toContain('/libs/shared/');
});

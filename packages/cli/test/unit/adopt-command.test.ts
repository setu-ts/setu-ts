import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAdoptCommand } from '../../src/commands/adopt.ts';
import {
  moveFile,
  planAdoption,
  pruneAdoptedDirectories,
  rewriteEntryPort,
} from '../../src/workspace/adopt.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';
import { COMPOSE_FILE, DOCKERFILE } from '../../src/workspace/compose.ts';

/** A scaffolded project, plus the repository files that must NOT move. */
const PROJECT: Readonly<Record<string, string>> = {
  '/work/svc/deno.json': '{ "tasks": { "start": "deno run main.ts" } }\n',
  '/work/svc/setu.config.ts': 'export function createApp() {}\n',
  '/work/svc/main.ts': `import { createApp } from './setu.config.ts';\n` +
    `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`,
  '/work/svc/README.md': '# svc\n',
  '/work/svc/.gitignore': 'coverage/\n',
  '/work/svc/src/controllers/index.ts': 'export const routes = [];\n',
  '/work/svc/src/plugins/index.ts': 'export const GENERATED_PLUGINS = [];\n',
  // Repository-level files. A workspace has ONE lockfile and ONE history, both at
  // the top, so a conversion that moved these would break the checkout.
  '/work/svc/deno.lock': '{}\n',
  '/work/svc/.git/HEAD': 'ref: refs/heads/main\n',
  '/work/svc/.github/workflows/ci.yml': 'name: ci\n',
};

/**
 * The same project on the npm toolchain.
 *
 * Its root manifest is `package.json` and it carries an `.npmrc` — both of which
 * the workspace root ALSO emits, and both of which move into the member. A
 * conversion that exempts only `deno.json` from the overwrite check therefore
 * refuses every npm and Bun project, which is what shipped.
 */
const NODE_PROJECT: Readonly<Record<string, string>> = {
  '/work/svc/package.json': '{ "scripts": { "start": "tsx main.ts" } }\n',
  '/work/svc/.npmrc': '@jsr:registry=https://npm.jsr.io\n',
  '/work/svc/tsconfig.json': '{}\n',
  '/work/svc/setu.config.ts': 'export function createApp() {}\n',
  '/work/svc/main.ts': `import { createApp } from './setu.config.ts';\n` +
    `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`,
  '/work/svc/README.md': '# svc\n',
  '/work/svc/src/controllers/index.ts': 'export const routes = [];\n',
  '/work/svc/package-lock.json': '{}\n',
};

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

/**
 * Builds a harness over a project at `/work/svc`.
 *
 * @param seed - Files the project starts with
 * @returns The harness
 */
function harness(seed: Readonly<Record<string, string>> = PROJECT): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runAdoptCommand(parseArgs(argv), {
        fs,
        cwd: '/work/svc',
        log: out.sink,
        error: err.sink,
      }),
  };
}

describe('planAdoption', () => {
  it('refuses a directory with no config module', async () => {
    const fs = createFakeFs({ '/work/svc/main.ts': 'x' });
    const plan = await planAdoption(fs, '/work/svc', 'apps/svc');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('setu.config.ts');
  });

  it('walks an adopted directory so nested source moves with it', async () => {
    const fs = createFakeFs(PROJECT);
    const plan = await planAdoption(fs, '/work/svc', 'apps/svc');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const froms = plan.files.map((f) => f.from);
    expect(froms).toContain('src/controllers/index.ts');
    expect(froms).toContain('src/plugins/index.ts');
    // Every move lands under the member root.
    for (const file of plan.files) expect(file.to.startsWith('apps/svc/')).toBe(true);
  });

  // This is the correctness property, not caution: a workspace has one lockfile
  // and one history, at the top. Moving them would relocate the repository.
  it('leaves the repository-level files where they are', async () => {
    const fs = createFakeFs(PROJECT);
    const plan = await planAdoption(fs, '/work/svc', 'apps/svc');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const froms = plan.files.map((f) => f.from);
    expect(froms).not.toContain('deno.lock');
    expect(froms.some((from) => from.startsWith('.git'))).toBe(false);
  });

  it('skips an entry the project does not have', async () => {
    const fs = createFakeFs(PROJECT);
    const plan = await planAdoption(fs, '/work/svc', 'apps/svc');
    expect(plan.ok).toBe(true);
    // No template emits all of them, so an absent entry is normal.
    if (plan.ok) expect(plan.files.map((f) => f.from)).not.toContain('wrangler.toml');
  });
});

describe('moveFile', () => {
  it('copies then removes, leaving the file only at its destination', async () => {
    const fs = createFakeFs({ '/work/svc/main.ts': 'body' });
    const outcome = await moveFile(fs, '/work/svc', { from: 'main.ts', to: 'apps/svc/main.ts' });
    expect(outcome.ok).toBe(true);
    expect(fs.read('/work/svc/apps/svc/main.ts')).toBe('body');
    await expect(fs.readFile('/work/svc/main.ts')).rejects.toThrow();
  });

  // The order is what a failure hangs on: the original is deleted LAST, so a crash
  // leaves the file in both places rather than in neither.
  it('reports a failure without removing the original', async () => {
    const fs = createFakeFs({ '/work/svc/main.ts': 'body' });
    const broken: typeof fs = {
      ...fs,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    const outcome = await moveFile(broken, '/work/svc', {
      from: 'main.ts',
      to: 'apps/svc/main.ts',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('disk full');
    // Still there.
    expect(fs.read('/work/svc/main.ts')).toBe('body');
  });

  it('refuses to delete the original when the copy is short', async () => {
    const fs = createFakeFs({ '/work/svc/main.ts': 'a longer body' });
    const truncating: typeof fs = {
      ...fs,
      readFile: (path: string) =>
        path.includes('apps/svc') ? Promise.resolve(new Uint8Array(2)) : fs.readFile(path),
    };
    const outcome = await moveFile(truncating, '/work/svc', {
      from: 'main.ts',
      to: 'apps/svc/main.ts',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('the original is untouched');
    expect(fs.read('/work/svc/main.ts')).toBe('a longer body');
  });
});

describe('pruneAdoptedDirectories', () => {
  it('removes a directory whose files have all moved', async () => {
    const fs = createFakeFs({ '/work/svc/src/a.ts': 'x' });
    await fs.rm('/work/svc/src/a.ts');
    expect(await pruneAdoptedDirectories(fs, '/work/svc', ['src'])).toEqual([]);
    await expect(fs.stat('/work/svc/src')).rejects.toThrow();
  });

  // A file left behind means something this command did not move, so the directory
  // stays and is reported rather than deleted recursively on an assumption.
  it('keeps and reports a directory that still holds a file', async () => {
    const fs = createFakeFs({ '/work/svc/src/kept.ts': 'x' });
    expect(await pruneAdoptedDirectories(fs, '/work/svc', ['src'])).toEqual(['src']);
    expect((await fs.stat('/work/svc/src')).isDirectory).toBe(true);
  });
});

describe('rewriteEntryPort', () => {
  const entry = `import { createApp } from './setu.config.ts';\n` +
    `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`;

  it('binds the allocated port through the discovery module', () => {
    const result = rewriteEntryPort(entry, 'SERVICE_PORT', './src/discovery/services.ts');
    expect(result).toContain(`import { SERVICE_PORT } from './src/discovery/services.ts';`);
    expect(result).toContain('await app.start({ port: SERVICE_PORT });');
    expect(result).not.toContain('3000');
  });

  // A developer may have changed the entry; guessing at an edit there would be
  // worse than reporting the two lines to change.
  it('declines an entry that no longer carries the literal', () => {
    expect(rewriteEntryPort('await app.start({ port: Number(x) });', 'P', './p.ts'))
      .toBeUndefined();
  });
});

describe('runAdoptCommand', () => {
  it('prints its usage under --help and exits 0', async () => {
    const h = harness();
    expect(await h.run(['--help'])).toBe(0);
    expect(h.out.text()).toContain('setu adopt');
  });

  it('refuses a directory that is already a workspace', async () => {
    const h = harness({
      ...PROJECT,
      [`/work/svc/${WORKSPACE_MANIFEST}`]:
        '{"version":1,"basePort":3000,"transport":"http","members":[]}',
    });
    expect(await h.run([])).toBe(1);
    expect(h.err.text()).toContain('already exists');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a directory with no Setu project in it', async () => {
    const h = harness({ '/work/svc/main.ts': 'x' });
    expect(await h.run([])).toBe(1);
    expect(h.err.text()).toContain('not a Setu project');
    expect(h.fs.writes).toEqual([]);
  });

  it('writes and moves nothing under --dry-run', async () => {
    const h = harness();
    expect(await h.run(['--dry-run'])).toBe(0);
    expect(h.fs.writes).toEqual([]);
    expect(h.out.text()).toContain('would move main.ts -> apps/svc/main.ts');
    expect(h.out.text()).toContain('would create /work/svc/setu.workspace.json');
  });

  it('moves the project under apps/ and writes the workspace above it', async () => {
    const h = harness();
    expect(await h.run(['--port', '4000'])).toBe(0);

    expect(h.fs.read('/work/svc/apps/svc/setu.config.ts')).toContain('createApp');
    expect(h.fs.read('/work/svc/apps/svc/src/controllers/index.ts')).toContain('routes');
    expect(h.fs.has(`/work/svc/${WORKSPACE_MANIFEST}`)).toBe(true);
    expect(h.fs.has(`/work/svc/${DOCKERFILE}`)).toBe(true);
    expect(h.fs.has(`/work/svc/${COMPOSE_FILE}`)).toBe(true);
    // The member is registered on the port it was given, and has the map its
    // future siblings will appear in.
    const manifest = JSON.parse(h.fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
      members: { name: string; port: number }[];
    };
    expect(manifest.members).toEqual([{ name: 'svc', port: 4000 }]);
    expect(h.fs.read(`/work/svc/apps/svc/${DISCOVERY_MODULE}`)).toContain(
      'export const SERVICE_PORT = 4000;',
    );
  });

  // Without this the converted member binds 3000 while every sibling's map names
  // the port the workspace allocated it.
  it('rewrites the entry to bind the allocated port', async () => {
    const h = harness();
    expect(await h.run(['--port', '4000'])).toBe(0);
    const entry = h.fs.read('/work/svc/apps/svc/main.ts');
    expect(entry).toContain(`import { SERVICE_PORT } from './src/discovery/services.ts';`);
    expect(entry).toContain('await app.start({ port: SERVICE_PORT });');
  });

  it('reports the two lines to change when the entry cannot be rewritten', async () => {
    const h = harness({
      ...PROJECT,
      '/work/svc/main.ts': `import { createApp } from './setu.config.ts';\n` +
        `const app = await createApp();\nawait app.start({ port: Number(Deno.args[0]) });\n`,
    });
    expect(await h.run([])).toBe(0);
    expect(h.out.text()).toContain('bind the allocated');
    expect(h.out.text()).toContain('SERVICE_PORT');
  });

  it('keeps the repository files at the root and prunes the emptied directories', async () => {
    const h = harness();
    expect(await h.run([])).toBe(0);
    expect(h.fs.read('/work/svc/deno.lock')).toBe('{}\n');
    expect(h.fs.read('/work/svc/.git/HEAD')).toContain('refs/heads/main');
    expect(h.fs.read('/work/svc/.github/workflows/ci.yml')).toContain('name: ci');
    // The developer's own ignore rules stay; the root does not overwrite them.
    expect(h.fs.read('/work/svc/.gitignore')).toBe('coverage/\n');
    // …and the directory the moved files came out of is gone.
    await expect(h.fs.stat('/work/svc/src')).rejects.toThrow();
  });

  // The whole npm path, which nothing exercised: `package.json` and `.npmrc` are
  // both emitted by the root AND owned by the project, so the overwrite check has
  // to run against the post-move state rather than against a list of one filename.
  it('converts an npm project, whose manifest collides with the root it writes', async () => {
    const h = harness(NODE_PROJECT);
    expect(await h.run([])).toBe(0);
    expect(h.err.text()).toBe('');

    // The project's own manifest went into the member…
    expect(h.fs.read('/work/svc/apps/svc/package.json')).toContain('tsx main.ts');
    expect(h.fs.has('/work/svc/apps/svc/.npmrc')).toBe(true);
    // …and the workspace root's took its place at the top.
    const root = JSON.parse(h.fs.read('/work/svc/package.json')) as { workspaces?: string[] };
    expect(root.workspaces).toEqual(['apps/*', 'libs/*']);
    // Recorded as an npm workspace, so every later command reads the right one.
    const manifest = JSON.parse(h.fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
      runtime?: string;
    };
    expect(manifest.runtime).toBe('node');
  });

  // A dry run that prints a clean plan for a conversion the real run refuses is
  // worse than no dry run at all.
  it('reports a collision under --dry-run instead of promising it would work', async () => {
    const h = harness({ ...PROJECT, [`/work/svc/apps/svc/${DISCOVERY_MODULE}`]: 'left over\n' });
    expect(await h.run(['--dry-run'])).toBe(1);
    expect(h.out.text()).toContain('WOULD REFUSE');
    expect(h.fs.writes).toEqual([]);
  });

  it('takes the member name from --name over the directory', async () => {
    const h = harness();
    expect(await h.run(['--name', 'orders'])).toBe(0);
    expect(h.fs.has('/work/svc/apps/orders/setu.config.ts')).toBe(true);
  });

  it('refuses a member name that cannot form an identifier', async () => {
    const h = harness();
    expect(await h.run(['--name', '2fa'])).toBe(2);
    expect(h.err.text()).toContain('--name');
    expect(h.fs.writes).toEqual([]);
  });

  // `--dir .` is the obvious way to name the current directory, and the member
  // name is DERIVED from that path — so with the dot left unresolved the last
  // segment was literally `.`, which produced `apps/.` and died part-way through
  // the conversion on a bare `mkdir` errno. It now names the directory it means.
  it('converts through --dir . exactly as it does with no --dir at all', async () => {
    const dotted = harness();
    expect(await dotted.run(['--dir', '.'])).toBe(0);
    expect(dotted.fs.read('/work/svc/apps/svc/setu.config.ts')).toContain('createApp');
    // No stray `/./` anywhere in what it reports, either.
    expect(dotted.out.text()).not.toContain('/./');

    const plain = harness();
    expect(await plain.run([])).toBe(0);
    expect([...plain.fs.writes].sort()).toEqual([...dotted.fs.writes].sort());
  });

  it('refuses a port no service can bind, through the shared reader', async () => {
    const h = harness();
    expect(await h.run(['--port', '99999'])).toBe(2);
    expect(h.err.text()).toContain('Invalid --port "99999"');
    expect(h.fs.writes).toEqual([]);
  });

  // A leftover from a half-finished run: `apps/svc/` already holding the module
  // this would write. The Compose and Kubernetes files are exempt because they are
  // `managed` — the CLI owns and regenerates those — and the project's own
  // `deno.json` is exempt because it MOVES out of the way first.
  it('refuses when a planned file already exists', async () => {
    const h = harness({
      ...PROJECT,
      [`/work/svc/apps/svc/${DISCOVERY_MODULE}`]: 'left over\n',
    });
    expect(await h.run([])).toBe(1);
    expect(h.err.text()).toContain('Refusing to overwrite');
    expect(h.fs.writes).toEqual([]);
  });

  // Stopping part-way is safe BECAUSE of the copy-verify-delete order, and the
  // message has to say so — every file moved so far exists in both places.
  it('stops and says nothing is lost when a move fails', async () => {
    const fs = createFakeFs(PROJECT);
    const err = createRecorder();
    const failing = {
      ...fs,
      writeFile: (path: string, data: Uint8Array) =>
        path.includes('apps/svc/src/')
          ? Promise.reject(new Error('disk full'))
          : fs.writeFile(path, data),
    };
    const code = await runAdoptCommand(parseArgs([]), {
      fs: failing,
      cwd: '/work/svc',
      log: createRecorder().sink,
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('disk full');
    expect(err.text()).toContain('nothing is lost');
  });

  // The guard exists for a file that appears AFTER the plan was made — an editor
  // writing into `src/` mid-run. An adopted directory is walked wholesale, so
  // nothing present at plan time is ever left behind; what must never happen is a
  // recursive delete of something this command did not move.
  it('keeps and reports a directory that gained a file after the plan', async () => {
    const fs = createFakeFs(PROJECT);
    const out = createRecorder();
    let moved = false;
    const racing = {
      ...fs,
      writeFile: async (path: string, data: Uint8Array) => {
        await fs.writeFile(path, data);
        // A real file, written into the directory mid-run, the way an editor
        // saving would: a fake that only reported the NAME would be caught by the
        // walk's own stat and prove nothing.
        if (path.includes('apps/svc/src/') && !moved) {
          moved = true;
          await fs.writeFile('/work/svc/src/appeared.ts', new TextEncoder().encode('later\n'));
        }
      },
    };
    const code = await runAdoptCommand(parseArgs([]), {
      fs: racing,
      cwd: '/work/svc',
      log: out.sink,
      error: createRecorder().sink,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('kept src/');
  });

  // The workspace root's own README documents the install command, the ports and
  // the transport. The project's copy MOVES into the member, so suppressing the
  // root's because "the project already has one" left the workspace with none.
  it('leaves the root a README of its own, since the project takes its copy along', async () => {
    const h = harness();
    expect(await h.run([])).toBe(0);
    expect(h.fs.read('/work/svc/apps/svc/README.md')).toBe('# svc\n');
    const root = h.fs.read('/work/svc/README.md');
    expect(root).not.toBe('# svc\n');
    expect(root).toContain('workspace');
  });

  it('names the toolchain the converted project actually uses in its next step', async () => {
    const deno = harness();
    expect(await deno.run([])).toBe(0);
    expect(deno.out.text()).toContain('deno task dev');

    const node = harness(NODE_PROJECT);
    expect(await node.run([])).toBe(0);
    expect(node.out.text()).toContain('npm run dev');
    expect(node.out.text()).not.toContain('deno task');
  });

  it('reports a write failure rather than throwing', async () => {
    const fs = createFakeFs(PROJECT);
    const err = createRecorder();
    const failing = {
      ...fs,
      writeFile: (path: string, data: Uint8Array) =>
        path.endsWith(WORKSPACE_MANIFEST)
          ? Promise.reject(new Error('read-only volume'))
          : fs.writeFile(path, data),
    };
    const code = await runAdoptCommand(parseArgs([]), {
      fs: failing,
      cwd: '/work/svc',
      log: createRecorder().sink,
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('read-only volume');
  });
});

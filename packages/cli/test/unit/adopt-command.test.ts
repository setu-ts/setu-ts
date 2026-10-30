import { describe, expect, it } from 'vitest';
import type { IFileSystem } from '@setu-ts/common';
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
import { InterruptedError } from '../../src/utils/interruption.ts';

/** A scaffolded project, plus the repository files that must NOT move. */
const PROJECT: Readonly<Record<string, string>> = {
  '/work/svc/deno.json': '{ "tasks": { "start": "deno run main.ts" } }\n',
  '/work/svc/setu.config.ts': 'export function createApp() {}\n',
  '/work/svc/main.ts':
    `import { createApp } from './setu.config.ts';\n` +
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
  '/work/svc/main.ts':
    `import { createApp } from './setu.config.ts';\n` +
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
  const entry =
    `import { createApp } from './setu.config.ts';\n` +
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
    expect(
      rewriteEntryPort('await app.start({ port: Number(x) });', 'P', './p.ts'),
    ).toBeUndefined();
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

  describe('probe support recorded from the project dependencies', () => {
    /** Runs adopt over the project with the given `@setu-ts` imports declared. */
    const adoptWith = async (imports: Readonly<Record<string, string>>): Promise<Harness> => {
      const h = harness({
        ...PROJECT,
        '/work/svc/deno.json': JSON.stringify({ tasks: {}, imports }),
      });
      expect(await h.run([])).toBe(0);
      return h;
    };

    /** The member record the command persisted. */
    const member = (h: Harness): { healthProbes?: boolean; metricsEndpoint?: boolean } =>
      (
        JSON.parse(h.fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
          members: { healthProbes?: boolean; metricsEndpoint?: boolean }[];
        }
      ).members[0]!;

    it('records both when the project declares a starter', async () => {
      const h = await adoptWith({ '@setu-ts/rest-starter': 'npm:@setu-ts/rest-starter@^0.9.0' });

      expect(member(h)).toMatchObject({ healthProbes: true, metricsEndpoint: true });
      const yaml = h.fs.read('/work/svc/k8s/members.yaml');
      expect(yaml).toMatch(/readinessProbe:\n\s+httpGet:/);
      expect(yaml).toContain('prometheus.io/scrape');
    });

    it('records health support alone from health-plugin', async () => {
      const h = await adoptWith({ '@setu-ts/health-plugin': 'npm:@setu-ts/health-plugin@^0.9.0' });

      expect(member(h)).toMatchObject({ healthProbes: true, metricsEndpoint: false });
      const yaml = h.fs.read('/work/svc/k8s/members.yaml');
      expect(yaml).toMatch(/readinessProbe:\n\s+httpGet:/);
      expect(yaml).not.toContain('prometheus.io/scrape');
    });

    it('records the metrics endpoint alone from metrics-plugin', async () => {
      const h = await adoptWith({
        '@setu-ts/metrics-plugin': 'npm:@setu-ts/metrics-plugin@^0.9.0',
      });

      expect(member(h)).toMatchObject({ healthProbes: false, metricsEndpoint: true });
      const yaml = h.fs.read('/work/svc/k8s/members.yaml');
      expect(yaml).toMatch(/readinessProbe:\n\s+tcpSocket:/);
      expect(yaml).toContain('prometheus.io/scrape');
    });

    it('records neither when the project declares no supporting package', async () => {
      const h = await adoptWith({ '@setu-ts/logger-plugin': 'npm:@setu-ts/logger-plugin@^0.9.0' });

      expect(member(h)).toMatchObject({ healthProbes: false, metricsEndpoint: false });
      const yaml = h.fs.read('/work/svc/k8s/members.yaml');
      expect(yaml).toMatch(/readinessProbe:\n\s+tcpSocket:/);
      expect(yaml).not.toContain('prometheus.io/scrape');
    });
  });

  describe('an interrupted adoption re-reads the moved manifest (V10-10)', () => {
    const interrupted = (manifest: Readonly<Record<string, string>>) =>
      harness({
        '/work/svc/setu.config.ts': 'export function createApp() {}\n',
        ...manifest,
      });
    const memberOf = (h: Harness) =>
      (
        JSON.parse(h.fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
          runtime: string;
          members: { healthProbes?: boolean; metricsEndpoint?: boolean }[];
        }
      ).members[0]!;

    it('records support declared by a package.json already under the member', async () => {
      const h = interrupted({
        '/work/svc/apps/svc/package.json': JSON.stringify({
          dependencies: {
            '@setu-ts/health-plugin': '^0.9.0',
            '@setu-ts/metrics-plugin': '^0.9.0',
          },
        }),
      });
      expect(await h.run([])).toBe(0);
      expect(memberOf(h)).toMatchObject({ healthProbes: true, metricsEndpoint: true });
      expect(h.fs.read('/work/svc/k8s/members.yaml')).toContain('prometheus.io/scrape');
    });

    it('never reads a manifest through a link planted at the member root', async () => {
      const fs = createFakeFs({
        '/work/svc/setu.config.ts': 'export function createApp() {}\n',
        '/work/svc/apps/svc/package.json': JSON.stringify({
          dependencies: { '@setu-ts/health-plugin': '^0.9.0' },
        }),
      });
      const member = '/work/svc/apps/svc';
      const read: string[] = [];
      const linked: IFileSystem = {
        ...fs,
        readFile: (path) => {
          read.push(path);
          return fs.readFile(path);
        },
        realPath: (path) =>
          path === member || path.startsWith(`${member}/`)
            ? Promise.resolve(`/elsewhere${path.slice(member.length)}`)
            : fs.realPath!(path),
      };
      await runAdoptCommand(parseArgs([]), {
        fs: linked,
        cwd: '/work/svc',
        log: () => {},
        error: () => {},
      });
      expect(read).not.toContain(`${member}/package.json`);
    });

    it('never reads a member manifest that is itself a link out of the project', async () => {
      const fs = createFakeFs({
        '/work/svc/setu.config.ts': 'export function createApp() {}\n',
        '/work/svc/apps/svc/package.json': JSON.stringify({
          dependencies: { '@setu-ts/health-plugin': '^0.9.0' },
        }),
      });
      const manifest = '/work/svc/apps/svc/package.json';
      const linked: IFileSystem = {
        ...fs,
        realPath: (path) =>
          path === manifest ? Promise.resolve('/elsewhere/package.json') : fs.realPath!(path),
      };
      await runAdoptCommand(parseArgs([]), {
        fs: linked,
        cwd: '/work/svc',
        log: () => {},
        error: () => {},
      });
      // Later steps (unchanged by M119h) may still touch the moved file; what the
      // probes must not do is let a foreign manifest decide the persisted support.
      const written = fs.has(`/work/svc/${WORKSPACE_MANIFEST}`)
        ? (JSON.parse(fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
            members: { healthProbes?: boolean }[];
          })
        : undefined;
      expect(written?.members[0]?.healthProbes ?? false).toBe(false);
    });

    it('keeps a Deno workspace Deno when the manifest already moved', async () => {
      const h = interrupted({
        '/work/svc/apps/svc/deno.json': '{ "tasks": {} }\n',
      });
      expect(await h.run([])).toBe(0);
      const persisted = JSON.parse(h.fs.read(`/work/svc/${WORKSPACE_MANIFEST}`)) as {
        runtime: string;
      };
      expect(persisted.runtime).toBe('deno');
    });
  });

  describe('the configured dotenv pair (V9-39)', () => {
    /** A config naming one env path, plus the files the pair needs. */
    const withEnv = (envFilePath: string, files: Readonly<Record<string, string>>) =>
      harness({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: '${envFilePath}', envFileOptional: true };\n`,
        ...files,
      });

    it('moves the default pair with the member, so the member reads its own env', async () => {
      const h = withEnv('.env', {
        '/work/svc/.env': 'SECRET=1\n',
        '/work/svc/.env.example': 'SECRET=\n',
      });

      expect(await h.run([])).toBe(0);

      expect(h.fs.has('/work/svc/.env')).toBe(false);
      expect(h.fs.has('/work/svc/.env.example')).toBe(false);
      expect(h.fs.read('/work/svc/apps/svc/.env')).toBe('SECRET=1\n');
      expect(h.fs.read('/work/svc/apps/svc/.env.example')).toBe('SECRET=\n');
      expect(h.out.text()).toContain('moved .env -> apps/svc/.env');
    });

    it('moves a custom single-segment name', async () => {
      const h = withEnv('name.env', {
        '/work/svc/name.env': 'SECRET=1\n',
        '/work/svc/name.env.example': 'SECRET=\n',
      });

      expect(await h.run([])).toBe(0);

      expect(h.fs.has('/work/svc/name.env')).toBe(false);
      expect(h.fs.read('/work/svc/apps/svc/name.env')).toBe('SECRET=1\n');
    });

    // A root rule such as `/.env` is anchored to the repository root, so it stops
    // matching once the file moves under apps/. A nested .gitignore is anchored to
    // its own directory and keeps the secret ignored (F1).
    it('writes a member .gitignore anchored to the moved dotenv file', async () => {
      const h = withEnv('.env', {
        '/work/svc/.env': 'SECRET=1\n',
        '/work/svc/.env.example': 'SECRET=\n',
      });

      expect(await h.run([])).toBe(0);

      const ignore = h.fs.read('/work/svc/apps/svc/.gitignore');
      expect(ignore).toContain('/.env');
      // The example is committed, so it is deliberately absent from the rules.
      expect(ignore).not.toContain('/.env.example');
    });

    it('anchors a custom single-segment dotenv name in the member .gitignore', async () => {
      const h = withEnv('local.env', { '/work/svc/local.env': 'SECRET=1\n' });

      expect(await h.run([])).toBe(0);

      expect(h.fs.read('/work/svc/apps/svc/.gitignore')).toContain('/local.env');
    });

    it('writes no member .gitignore when no dotenv file moves', async () => {
      const h = withEnv('.env', {});

      expect(await h.run([])).toBe(0);

      expect(h.fs.has('/work/svc/apps/svc/.gitignore')).toBe(false);
    });

    // The member directory is new, so this cannot happen in practice — but the
    // rule is appended rather than replacing whatever is already there.
    it('appends to a member .gitignore that already exists', async () => {
      for (const existing of ['coverage/', 'coverage/\n']) {
        const fs = createFakeFs({
          ...PROJECT,
          '/work/svc/setu.config.ts': `export const config = { envFilePath: '.env', envFileOptional: true };\n`,
          '/work/svc/.env': 'SECRET=1\n',
          '/work/svc/apps/svc/.gitignore': existing,
        });
        const plan = await planAdoption(fs, '/work/svc', 'apps/svc');

        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        const created = plan.creates?.find((file) => file.path === 'apps/svc/.gitignore');
        expect(created?.contents).toBe('coverage/\n/.env\n');
      }
    });

    // A directory, a FIFO or a link is not something the conversion wrote, and
    // reading one is how a committed special file hangs or exhausts the run.
    it('refuses a member .gitignore that is a directory, before moving anything', async () => {
      const h = withEnv('.env', {
        '/work/svc/.env': 'SECRET=1\n',
        '/work/svc/apps/svc/.gitignore/keep.txt': 'not a file\n',
      });

      expect(await h.run([])).toBe(1);

      expect(h.err.text()).toContain('apps/svc/.gitignore');
      expect(h.err.text()).toContain('not a regular file');
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.has('/work/svc/.env')).toBe(true);
      expect(h.fs.has('/work/svc/main.ts')).toBe(true);
    });

    // The bound is checked from `stat`, so an oversized file is refused rather
    // than read: the fake records every read so this cannot pass by luck.
    it('refuses a member .gitignore larger than 64 KiB without reading it', async () => {
      const target = '/work/svc/apps/svc/.gitignore';
      const fs = createFakeFs({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: '.env', envFileOptional: true };\n`,
        '/work/svc/.env': 'SECRET=1\n',
        [target]: 'x'.repeat(64 * 1024 + 1),
      });
      const reads: string[] = [];
      const readFile = fs.readFile.bind(fs);
      fs.readFile = (path) => {
        reads.push(path);
        return readFile(path);
      };
      const out = createRecorder();
      const err = createRecorder();
      const code = await runAdoptCommand(parseArgs([]), {
        fs,
        cwd: '/work/svc',
        log: out.sink,
        error: err.sink,
      });

      expect(code).toBe(1);
      expect(err.text()).toContain('larger than the 64 KiB');
      expect(reads).not.toContain(target);
      expect(fs.writes).toEqual([]);
      expect(fs.has('/work/svc/.env')).toBe(true);
    });

    // The generated .dockerignore covers .env and .env.* only. A custom name would
    // be copied into the image, so the step to add it is printed.
    it('prints the .dockerignore step only for a name the generic rules miss', async () => {
      const covered = withEnv('.env', { '/work/svc/.env': 'SECRET=1\n' });
      expect(await covered.run([])).toBe(0);
      expect(covered.out.text()).not.toContain('to .dockerignore');

      const custom = withEnv('local.env', { '/work/svc/local.env': 'SECRET=1\n' });
      expect(await custom.run([])).toBe(0);
      expect(custom.out.text()).toContain(
        'Add apps/svc/local.env to .dockerignore: the generated rules cover only .env and .env.* names, ' +
          'so this file would be copied into the image.',
      );
    });

    it('does not move a multi-segment path, and prints the step to take', async () => {
      const h = withEnv('config/.env', {
        '/work/svc/config/.env': 'SECRET=1\n',
        '/work/svc/config/.env.example': 'SECRET=\n',
      });

      expect(await h.run([])).toBe(0);

      // A root ignore pattern containing a slash is anchored, so moving the file
      // would silently stop ignoring it; the developer is told to move it by hand.
      expect(h.fs.read('/work/svc/config/.env')).toBe('SECRET=1\n');
      expect(h.fs.has('/work/svc/apps/svc/config/.env')).toBe(false);
      expect(h.out.text()).toContain('spans directories, so it was not moved');
      expect(h.out.text()).toContain('move it into apps/svc/config/.env by hand');
    });

    it('prints the by-hand note only after the conversion succeeds', async () => {
      const h = withEnv('config/.env', {
        '/work/svc/config/.env': 'SECRET=1\n',
        '/work/svc/config/.env.example': 'SECRET=\n',
      });

      expect(await h.run([])).toBe(0);

      const output = h.out.text();
      const converted = output.indexOf('Converted into a workspace');
      const note = output.indexOf('spans directories, so it was not moved');
      expect(converted).toBeGreaterThanOrEqual(0);
      expect(note).toBeGreaterThan(converted);
    });

    it('prints no by-hand note when the conversion fails after planning', async () => {
      const h = withEnv('config/.env', {
        '/work/svc/config/.env': 'SECRET=1\n',
        '/work/svc/config/.env.example': 'SECRET=\n',
      });
      // Planning has already produced the note by now; the first move fails.
      h.fs.writeFile = () => Promise.reject(new Error('disk full'));

      expect(await h.run([])).toBe(1);
      expect(h.err.text()).toContain('disk full');
      expect(h.out.text()).not.toContain('spans directories');
    });

    it('moves nothing, and does not fail, when neither file exists', async () => {
      const h = withEnv('.env', {});

      expect(await h.run([])).toBe(0);

      expect(h.fs.has('/work/svc/apps/svc/.env')).toBe(false);
    });

    it('leaves a configured path that is a directory where it is', async () => {
      // `src` passes the path validation, but adopting it as the dotenv file
      // would list the whole directory as one move rather than walk it.
      const fs = createFakeFs({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: 'src', envFileOptional: true };\n`,
      });
      const plan = await planAdoption(fs, '/work/svc', 'apps/svc');

      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.files.map((file) => file.from)).not.toContain('src');
    });

    it('does not plan a configured path a static entry already moved', async () => {
      // `README.md` is a legal dotenv name and is also in the adopted entry set.
      // A second move would list the same destination twice.
      const fs = createFakeFs({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: 'README.md', envFileOptional: true };\n`,
      });
      const plan = await planAdoption(fs, '/work/svc', 'apps/svc');

      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.files.filter((file) => file.from === 'README.md')).toHaveLength(1);
      }
    });

    it('refuses a configured path that resolves outside the project', async () => {
      const fs = createFakeFs({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: '.env', envFileOptional: true };\n`,
        '/work/svc/.env': 'SECRET=1\n',
      });
      const realPath = fs.realPath?.bind(fs);
      expect(realPath).toBeDefined();
      if (realPath === undefined) return;
      fs.realPath = (path) =>
        path === '/work/svc/.env' ? Promise.resolve('/outside/.env') : realPath(path);
      const plan = await planAdoption(fs, '/work/svc', 'apps/svc');

      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.message).toContain('symbolic link');
    });

    it('skips the pair when the config cannot be read', async () => {
      // The config was stat-able before planning; a read failure here leaves the
      // file where it is rather than failing the conversion.
      const fs = createFakeFs({
        ...PROJECT,
        '/work/svc/setu.config.ts': `export const config = { envFilePath: '.env', envFileOptional: true };\n`,
        '/work/svc/.env': 'SECRET=1\n',
      });
      const readFile = fs.readFile.bind(fs);
      fs.readFile = (path) =>
        path === '/work/svc/setu.config.ts'
          ? Promise.reject(new Error('read refused'))
          : readFile(path);
      const plan = await planAdoption(fs, '/work/svc', 'apps/svc');

      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.files.map((file) => file.from)).not.toContain('.env');
    });
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

  it('returns 130 without moving anything when already interrupted', async () => {
    const fs = createFakeFs(PROJECT);
    const controller = new AbortController();
    controller.abort();
    const err = createRecorder();
    expect(
      await runAdoptCommand(parseArgs([]), {
        fs,
        cwd: '/work/svc',
        log: () => {},
        error: err.sink,
        interrupt: controller.signal,
      }),
    ).toBe(130);
    expect(fs.read('/work/svc/main.ts')).toContain('createApp');
    expect(fs.has('/work/svc/apps/svc/main.ts')).toBe(false);
    expect(err.text()).toContain('Interrupted;');
  });

  // A pre-0.9 project pins the framework from JSR (Deno) or through the JSR npm
  // alias (npm); the workspace root maps neither any more, so adoption moves
  // the member's pins onto the npm names and says which it moved.
  it('moves a Deno project off JSR pins as it adopts it', async () => {
    const h = harness({
      ...PROJECT,
      '/work/svc/deno.json': JSON.stringify({
        tasks: { start: 'deno run main.ts' },
        imports: { '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^0.8.0' },
      }),
    });
    expect(await h.run(['--port', '4000'])).toBe(0);
    const manifest = JSON.parse(h.fs.read('/work/svc/apps/svc/deno.json')) as {
      imports: Record<string, string>;
    };
    expect(manifest.imports['@setu-ts/kernel']).toMatch(/^npm:@setu-ts\/kernel@\^/);
    expect(h.out.text()).toContain(
      `moved @setu-ts/kernel from jsr:@setu-ts/kernel@^0.8.0 to ${
        manifest.imports['@setu-ts/kernel']
      }`,
    );
  });

  // A Deno manifest may carry JSONC comments and trailing commas; `JSON.parse`
  // used to skip such a file silently, leaving its JSR pins unmapped. Its pins
  // move and its comments survive, because the rewrite edits values in place.
  it('moves a commented deno.json off JSR pins and keeps its comments', async () => {
    const h = harness({
      ...PROJECT,
      '/work/svc/deno.json': [
        '{',
        '  // framework pins',
        '  "imports": { "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0", },',
        '}',
        '',
      ].join('\n'),
    });
    expect(await h.run(['--port', '4000'])).toBe(0);
    const manifest = h.fs.read('/work/svc/apps/svc/deno.json');
    expect(manifest).toContain('// framework pins');
    expect(manifest).toMatch(/"@setu-ts\/kernel": "npm:@setu-ts\/kernel@\^/);
    expect(h.out.text()).toContain('moved @setu-ts/kernel from jsr:@setu-ts/kernel@^0.8.0');
  });

  // A `deno.jsonc` project: the manifest moves with the member (it used to stay
  // at the root, beside the workspace's new `deno.json`), its pins move onto npm,
  // and its comments survive.
  it('moves a deno.jsonc manifest into the member and rewrites its pins', async () => {
    const { ['/work/svc/deno.json']: _dropped, ...withoutJson } = PROJECT;
    const h = harness({
      ...withoutJson,
      '/work/svc/deno.jsonc': [
        '{',
        '  // framework pins',
        '  "imports": { "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0", },',
        '}',
        '',
      ].join('\n'),
    });
    expect(await h.run(['--port', '4000'])).toBe(0);
    const member = h.fs.read('/work/svc/apps/svc/deno.jsonc');
    expect(member).toContain('// framework pins');
    expect(member).toMatch(/"@setu-ts\/kernel": "npm:@setu-ts\/kernel@\^/);
    expect(h.out.text()).toContain('moved deno.jsonc -> apps/svc/deno.jsonc');
    // The root holds the workspace manifest alone.
    expect(h.fs.has('/work/svc/deno.jsonc')).toBe(false);
    expect(JSON.parse(h.fs.read('/work/svc/deno.json'))).toHaveProperty('workspace');
  });

  it('reports a manifest it cannot read rather than skipping it silently', async () => {
    const h = harness({ ...PROJECT, '/work/svc/deno.json': '{ "imports": { ' });
    expect(await h.run(['--port', '4000'])).toBe(0);
    expect(h.err.text()).toContain('to move its framework pins onto npm');
    expect(h.err.text()).toContain('by hand');
  });

  it('moves an npm project off the JSR alias as it adopts it', async () => {
    const h = harness({
      ...NODE_PROJECT,
      '/work/svc/package.json': JSON.stringify({
        scripts: { start: 'tsx main.ts' },
        dependencies: { '@setu-ts/kernel': 'npm:@jsr/setu-ts__kernel@^0.8.0' },
      }),
    });
    expect(await h.run(['--port', '4000'])).toBe(0);
    const manifest = JSON.parse(h.fs.read('/work/svc/apps/svc/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@setu-ts/kernel']).toMatch(/^\^\d/);
    expect(h.out.text()).toContain('moved @setu-ts/kernel from npm:@jsr/setu-ts__kernel@^0.8.0');
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
    expect(manifest.members).toEqual([
      { name: 'svc', port: 4000, healthProbes: false, metricsEndpoint: false },
    ]);
    expect(h.fs.read(`/work/svc/apps/svc/${DISCOVERY_MODULE}`)).toContain(
      'export const SERVICE_PORT = 4000;',
    );
  });

  it('adopts through prototype filesystem methods with their original receiver', async () => {
    class PrototypeFs implements IFileSystem {
      constructor(private readonly backing: IFileSystem) {}
      readFile(path: string) {
        return this.backing.readFile(path);
      }
      writeFile(path: string, data: Uint8Array) {
        return this.backing.writeFile(path, data);
      }
      stat(path: string) {
        return this.backing.stat(path);
      }
      readdir(path: string) {
        return this.backing.readdir(path);
      }
      realPath(path: string) {
        return this.backing.realPath!(path);
      }
      mkdir(path: string, options?: { readonly recursive?: boolean }) {
        return this.backing.mkdir(path, options);
      }
      rm(path: string, options?: { readonly recursive?: boolean }) {
        return this.backing.rm(path, options);
      }
    }
    const backing = createFakeFs(PROJECT);
    const err = createRecorder();
    expect(
      await runAdoptCommand(parseArgs([]), {
        fs: new PrototypeFs(backing),
        cwd: '/work/svc',
        log: () => {},
        error: err.sink,
      }),
    ).toBe(0);
    expect(err.text()).toBe('');
    expect(backing.read('/work/svc/apps/svc/setu.config.ts')).toContain('createApp');
    expect(backing.read('/work/svc/apps/svc/main.ts')).toContain('port: SERVICE_PORT');
    expect(backing.has('/work/svc/main.ts')).toBe(false);
  });

  it('returns 130 and names incomplete recovery after nested batch rollback fails', async () => {
    const backing = createFakeFs(PROJECT);
    const controller = new AbortController();
    const err = createRecorder();
    const fs: IFileSystem = {
      ...backing,
      async writeFile(path, data) {
        if (controller.signal.aborted && path === '/work/svc/setu.config.ts') {
          throw new Error('restore denied');
        }
        await backing.writeFile(path, data);
        if (path === `/work/svc/${WORKSPACE_MANIFEST}`) controller.abort();
      },
    };
    expect(
      await runAdoptCommand(parseArgs([]), {
        fs,
        cwd: '/work/svc',
        log: () => {},
        error: err.sink,
        interrupt: controller.signal,
      }),
    ).toBe(130);
    expect(err.text()).toContain('Interrupted; rollback was incomplete:');
    expect(err.text()).toContain('/work/svc/setu.config.ts: restore denied');
    expect(err.text()).not.toContain('files this run wrote were removed');
    expect(backing.read('/work/svc/main.ts')).toBe(PROJECT['/work/svc/main.ts']);
    expect(backing.has('/work/svc/setu.config.ts')).toBe(false);
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
      '/work/svc/main.ts':
        `import { createApp } from './setu.config.ts';\n` +
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

  // A ROOT file the conversion writes is not part of the planner's `creates`
  // list, so it used to escape the up-front containment check: the dry run
  // printed a clean plan and the real run refused only after moving files.
  it('refuses a planned root file that resolves outside the project before moving', async () => {
    const fs = createFakeFs(PROJECT);
    const realPath = fs.realPath?.bind(fs);
    expect(realPath).toBeDefined();
    if (realPath === undefined) return;
    fs.realPath = (path) =>
      path === '/work/svc/.dockerignore'
        ? Promise.resolve('/outside/.dockerignore')
        : realPath(path);
    const out = createRecorder();
    const err = createRecorder();
    const code = await runAdoptCommand(parseArgs([]), {
      fs,
      cwd: '/work/svc',
      log: out.sink,
      error: err.sink,
    });

    expect(code).toBe(1);
    expect(err.text()).toContain('symbolic link');
    expect(out.text()).not.toContain('moved ');
    expect(fs.writes).toEqual([]);
    expect(fs.has('/work/svc/main.ts')).toBe(true);
    expect(fs.has('/work/svc/apps/svc/main.ts')).toBe(false);
  });

  // A MOVE's destination is not a generated file, so the up-front loop used to
  // skip it: `moveFile` refused after the earlier moves had run and the
  // transaction rolled them back, which is a real run disagreeing with a clean
  // dry run.
  it('refuses a planned move destination that resolves outside the project before moving', async () => {
    const fs = createFakeFs(PROJECT);
    const realPath = fs.realPath?.bind(fs);
    expect(realPath).toBeDefined();
    if (realPath === undefined) return;
    fs.realPath = (path) =>
      path === '/work/svc/apps/svc/README.md'
        ? Promise.resolve('/outside/README.md')
        : realPath(path);
    const out = createRecorder();
    const err = createRecorder();
    const code = await runAdoptCommand(parseArgs([]), {
      fs,
      cwd: '/work/svc',
      log: out.sink,
      error: err.sink,
    });

    expect(code).toBe(1);
    expect(err.text()).toContain('symbolic link');
    expect(out.text()).not.toContain('moved ');
    expect(fs.writes).toEqual([]);
    expect(fs.has('/work/svc/README.md')).toBe(true);
    expect(fs.has('/work/svc/apps/svc/README.md')).toBe(false);
  });

  it('reports an inspection failure before moving project files', async () => {
    const fs = createFakeFs(PROJECT);
    const out = createRecorder();
    const err = createRecorder();
    const result = await runAdoptCommand(parseArgs([]), {
      fs: {
        ...fs,
        stat(path) {
          if (path === `/work/svc/${WORKSPACE_MANIFEST}`) {
            return Promise.reject(new Error('inspection denied'));
          }
          return fs.stat(path);
        },
      },
      cwd: '/work/svc',
      log: out.sink,
      error: err.sink,
    });

    expect(result).toBe(1);
    expect(err.text()).toContain('Failed to inspect existing files: inspection denied');
    expect(out.text()).not.toContain('moved ');
    expect(fs.writes).toEqual([]);
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

  // A failure after the first move must undo it: the transaction rolls back a
  // throw, so the command reports the refusal instead of returning one.
  it('stops and rolls the failed conversion back when a move fails', async () => {
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
    expect(err.text()).toContain('Nothing was changed: every move was undone.');
    expect(err.text()).not.toContain('Stopped part-way');
    // The files that moved before the refusing one are back where they started.
    expect(failing.has('/work/svc/deno.json')).toBe(true);
    expect(failing.has('/work/svc/main.ts')).toBe(true);
    expect(failing.has('/work/svc/apps/svc/deno.json')).toBe(false);
    expect(failing.has('/work/svc/apps/svc/main.ts')).toBe(false);
  });

  // The guard exists for a file that appears AFTER the plan was made — an editor
  // writing into `src/` mid-run. An adopted directory is walked wholesale, so
  // nothing present at plan time is ever left behind; what must never happen is a
  // recursive delete of something this command did not move.
  // The reported failure used to happen AFTER every move, with no rollback: the
  // project's `.env` stayed under apps/ and could be staged. A root target that
  // refuses its write must leave the starting tree in place.
  it('restores every moved file when a root target cannot be written', async () => {
    const fs = createFakeFs(PROJECT);
    const err = createRecorder();
    const failing = {
      ...fs,
      writeFile: (path: string, data: Uint8Array) =>
        path === '/work/svc/.dockerignore'
          ? Promise.reject(new Error('read-only root'))
          : fs.writeFile(path, data),
    };
    const code = await runAdoptCommand(parseArgs([]), {
      fs: failing,
      cwd: '/work/svc',
      log: createRecorder().sink,
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('read-only root');
    expect(err.text()).toContain('Nothing was changed: every move was undone.');
    expect(err.text()).not.toContain('Stopped part-way');
    // Every source path is back, and the member tree is gone.
    for (const path of Object.keys(PROJECT)) {
      expect(failing.has(path)).toBe(true);
    }
    expect(failing.has('/work/svc/apps/svc/deno.json')).toBe(false);
    expect(failing.has('/work/svc/apps/svc/main.ts')).toBe(false);
    expect(failing.has('/work/svc/setu.workspace.json')).toBe(false);
  });

  it('undoes a completed move when the next one fails', async () => {
    const fs = createFakeFs(PROJECT);
    const err = createRecorder();
    const failing = {
      ...fs,
      writeFile: (path: string, data: Uint8Array) =>
        // The second move is `main.ts`: its source is still at the root.
        path === '/work/svc/apps/svc/main.ts' && fs.has('/work/svc/main.ts')
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
    expect(err.text()).toContain('Nothing was changed: every move was undone.');
    // The first move, `deno.json`, is back at the root.
    expect(failing.read('/work/svc/deno.json')).toBe(PROJECT['/work/svc/deno.json']);
    expect(failing.has('/work/svc/apps/svc/deno.json')).toBe(false);
    expect(failing.has('/work/svc/main.ts')).toBe(true);
  });

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

it('reports scalar failures while planning top-level and nested adoption paths', async () => {
  for (const nested of [false, true]) {
    const fs = createFakeFs(PROJECT);
    if (nested) fs.readdir = () => Promise.reject('cannot enumerate');
    else fs.realPath = () => Promise.reject('path unavailable');
    const result = await planAdoption(fs, '/work/svc', 'apps/svc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(nested ? 'cannot enumerate' : 'path unavailable');
    }
  }
});

it('reports an Error from walking a nested directory', async () => {
  const fs = createFakeFs(PROJECT);
  fs.readdir = () => Promise.reject(new Error('cannot enumerate'));
  const result = await planAdoption(fs, '/work/svc', 'apps/svc');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('cannot enumerate');
});

it('prunes only directories and preserves ordinary top-level files', async () => {
  const fs = createFakeFs({ '/root/config.ts': 'keep' });
  expect(await pruneAdoptedDirectories(fs, '/root', ['config.ts', 'absent'])).toEqual([]);
  expect(fs.read('/root/config.ts')).toBe('keep');
});

it('reports scalar move failures without deleting the original', async () => {
  const fs = createFakeFs({ '/work/file': 'original' });
  fs.writeFile = () => Promise.reject('write refused');
  const result = await moveFile(fs, '/work', { from: 'file', to: 'apps/file' });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('write refused');
  expect(fs.has('/work/file')).toBe(true);
});

it('reports write and entry-read failures without throwing scalar errors', async () => {
  for (const stage of ['workspace-write', 'entry-read', 'entry-write']) {
    const h = harness();
    const read = h.fs.readFile.bind(h.fs);
    const write = h.fs.writeFile.bind(h.fs);
    let entryReads = 0;
    let entryWrites = 0;
    h.fs.readFile = (path) => {
      if (path === '/work/svc/apps/svc/main.ts' && ++entryReads === 2 && stage === 'entry-read') {
        return Promise.reject('read refused');
      }
      return read(path);
    };
    h.fs.writeFile = (path, bytes) => {
      if (stage === 'workspace-write' && path === '/work/svc/setu.workspace.json') {
        return Promise.reject('write refused');
      }
      if (path === '/work/svc/apps/svc/main.ts' && ++entryWrites === 2 && stage === 'entry-write') {
        return Promise.reject('rewrite refused');
      }
      return write(path, bytes);
    };
    expect(await h.run(['adopt'])).toBe(1);
    expect(h.err.text()).toContain('refused');
  }
});

it('rethrows an interruption raised while rewriting the entry', async () => {
  const h = harness();
  const write = h.fs.writeFile.bind(h.fs);
  let entryWrites = 0;
  h.fs.writeFile = (path, bytes) => {
    // The move wrote the entry once; the port rewrite is the second write.
    if (path === '/work/svc/apps/svc/main.ts' && ++entryWrites === 2) {
      return Promise.reject(new InterruptedError());
    }
    return write(path, bytes);
  };

  expect(await h.run(['adopt'])).toBe(130);
  expect(h.err.text()).toContain('Interrupted;');
});

it('reports a scalar failure from the application log and refuses an unnamed root project', async () => {
  const h = harness();
  expect(
    await runAdoptCommand(parseArgs(['adopt']), {
      fs: h.fs,
      cwd: '/work/svc',
      log: () => {
        throw 'log refused';
      },
      error: h.err.sink,
    }),
  ).toBe(1);
  expect(h.err.text()).toContain('Failed to adopt: log refused');
  expect(
    await runAdoptCommand(parseArgs(['adopt']), {
      fs: createFakeFs(),
      cwd: '/',
      log: () => {},
      error: h.err.sink,
    }),
  ).toBe(2);
});

it('moves a root-directory file without trying to create an empty parent path', async () => {
  const fs = createFakeFs({ '/file': 'kept' });
  expect(await moveFile(fs, '/', { from: 'file', to: 'a' })).toEqual({ ok: true });
  expect(fs.read('/a')).toBe('kept');
  expect(fs.has('/file')).toBe(false);
  expect(fs.mkdirs).not.toContain('');
});

it('reports an Error while resolving an adoption path', async () => {
  const fs = createFakeFs(PROJECT);
  fs.realPath = () => Promise.reject(new Error('path unavailable'));
  const result = await planAdoption(fs, '/work/svc', 'apps/svc');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('path unavailable');
});

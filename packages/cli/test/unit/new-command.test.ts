import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';

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

describe('runNewCommand', () => {
  it('creates a deno project under the working directory by default', async () => {
    const h = harness();
    expect(await h.run(['my-app'])).toBe(0);
    expect(h.fs.has('/work/my-app/deno.json')).toBe(true);
    expect(h.fs.has('/work/my-app/main.ts')).toBe(true);
    expect(h.fs.has('/work/my-app/README.md')).toBe(true);
    expect(h.fs.has('/work/my-app/.gitignore')).toBe(true);
  });

  it('roots the project at --dir', async () => {
    const h = harness();
    expect(await h.run(['my-app', '--dir', '/tmp/sandbox'])).toBe(0);
    expect(h.fs.has('/tmp/sandbox/my-app/deno.json')).toBe(true);
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
      expect(main).toContain('RuntimePlugin()');
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

    it('emits a fetch entry with no listen call', async () => {
      const h = harness();
      await h.run(['app', '--runtime', 'cloudflare-workers']);
      const entry = h.fs.read('/work/app/src/index.ts');
      expect(entry).toContain('export default {');
      expect(entry).toContain('async fetch(request: Request)');
      expect(entry).not.toContain('listen');
      expect(entry).not.toContain('port: 3000');
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

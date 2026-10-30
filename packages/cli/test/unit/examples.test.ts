import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.ts';
import type { CliDependencies } from '../../src/cli.ts';
import { createArgs } from '../../../create/src/index.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { EXAMPLES, EXCLUDED_EXAMPLES, exampleTemplate } from '../../src/examples/catalog.ts';
import { EXAMPLE_MANIFEST } from '../../src/examples/manifest.ts';
import { examplePaths, FETCH_TIMEOUT_MS } from '../../src/examples/new.ts';
import {
  exampleTsconfig,
  rewriteExamplePackage,
  rewriteExampleReadme,
  rewriteExampleSource,
  rewriteSmokeHelper,
} from '../../src/examples/rewrite.ts';
import { VERSION } from '../../src/version.ts';

const root = new URL('../../../../', import.meta.url);
const repositoryFetch: typeof fetch = async (input) => {
  const path = String(input).split(`/v${VERSION}/`)[1];
  return new Response(await readFile(new URL(path, root)));
};
function harness(
  seed: Readonly<Record<string, string>> = {},
  fetchFile: typeof fetch | null = repositoryFetch,
) {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (args: readonly string[], extra: Partial<CliDependencies> = {}) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: out.sink,
        error: err.sink,
        ...(fetchFile === null ? {} : { fetch: fetchFile }),
        ...extra,
      }),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('example scaffolding', () => {
  it('downloads version-tagged sources, rewrites manifests and prints runnable next steps through both entry points', async () => {
    for (const argv of [['new', 'demo'], createArgs(['demo'])]) {
      const h = harness();
      expect(
        await h.run([...argv, '--example', 'grpc', '--runtime', 'node', '--dir', 'examples']),
        h.err.text(),
      ).toBe(0);
      const prefix = '/work/examples/demo/';
      const manifest = JSON.parse(h.fs.read(`${prefix}package.json`));
      expect(manifest.name).toBe('demo');
      expect(manifest.dependencies['@setu-ts/kernel']).toBe(`^${VERSION}`);
      expect(manifest.scripts.start).toBe('tsx main.ts');
      expect(manifest.scripts.check).toBe('tsc --noEmit');
      expect(manifest.devDependencies.typescript).toBe('~6.0.3');
      expect(manifest.devDependencies['@types/node']).toBe('^24.0.0');
      expect(h.fs.read(`${prefix}tsconfig.json`)).not.toMatch(/extends|paths/);
      expect(h.fs.read(`${prefix}smoke.ts`)).toContain('./smoke-helpers.ts');
      expect(h.fs.read(`${prefix}smoke-helpers.ts`)).not.toContain('source-register');
      expect(h.fs.read(`${prefix}README.md`)).toContain('https://setu-ts.dev/examples/grpc/');
      expect(h.fs.read(`${prefix}.gitignore`)).toBe('node_modules\ndist\n.env\n');
      expect(h.out.text()).toContain('cd demo && npm install');
      // The smoke check exits; `npm start` serves until stopped, so it comes last.
      expect(h.out.text().indexOf('npm run smoke')).toBeLessThan(h.out.text().indexOf('npm start'));
      expect(h.fs.writes.map((path) => path.slice(prefix.length)).sort()).toEqual(
        [...examplePaths('grpc')].sort(),
      );
    }
  });
  it('keeps binary assets byte-identical', async () => {
    const h = harness();
    expect(await h.run(['new', 'demo', '--example', 'static-site'])).toBe(0);
    expect(await h.fs.readFile('/work/demo/public/assets/app-a1b2c3d4.js.br')).toEqual(
      new Uint8Array(
        await readFile(new URL('apps/static-site/public/assets/app-a1b2c3d4.js.br', root)),
      ),
    );
  });
  it('uses the default global fetch and bypasses interactive template questions', async () => {
    const fetchFile = vi.fn(repositoryFetch);
    vi.stubGlobal('fetch', fetchFile);
    const ask = { select: vi.fn() };
    const h = harness({}, null);
    expect(await h.run(['new', 'demo', '--example', 'minimal'], { ask })).toBe(0);
    expect(fetchFile).toHaveBeenCalled();
    expect(ask.select).not.toHaveBeenCalled();
  });
  it('lists exactly every output path without fetching or writing', async () => {
    for (const example of EXAMPLES) {
      const fetchFile = vi.fn();
      const h = harness({}, fetchFile);
      expect(await h.run(['new', 'demo', '--example', example, '--dry-run'])).toBe(0);
      expect(fetchFile).not.toHaveBeenCalled();
      expect(h.fs.writes).toEqual([]);
      const paths = h.out.lines
        .filter((line) => line.startsWith('would create '))
        .map((line) => line.slice('would create /work/demo/'.length));
      expect(paths.sort()).toEqual([...examplePaths(example)].sort());
    }
  });
  it('refuses every incompatible flag by name before downloading', async () => {
    const flags = [
      '--template=rest',
      '--workspace',
      '--style=functional',
      '--runtime=bun',
      '--runtime=deno',
      '--runtime=cloudflare-workers',
      '--broker=redis',
      '--queue=redis',
      '--redis-client=node-redis',
      '--devtool',
      '--devtool-port=4500',
      '--logger=console',
      '--env-file=.env',
      '--transport=http',
      '--transport-url=x',
      '--port=3000',
      '--depends-on=x',
      '--di',
    ];
    for (const flag of flags) {
      const fetchFile = vi.fn();
      const h = harness({}, fetchFile);
      expect(await h.run(['new', 'demo', '--example', 'minimal', flag])).toBe(2);
      expect(h.err.text()).toContain(flag.split('=')[0]);
      expect(h.err.text()).toContain('--example');
      expect(fetchFile).not.toHaveBeenCalled();
      expect(h.fs.writes).toEqual([]);
    }
  });
  it('reports unknown, missing and prototype-key example names, and every excluded reason', async () => {
    for (const value of ['unknown', 'constructor', 'toString', undefined]) {
      const h = harness();
      expect(
        await h.run(['new', 'demo', '--example', ...(value === undefined ? [] : [value])]),
      ).toBe(1);
      for (const offered of EXAMPLES) expect(h.err.text()).toContain(offered);
      expect(h.fs.writes).toEqual([]);
    }
    for (const [name, reason] of Object.entries(EXCLUDED_EXAMPLES)) {
      const h = harness();
      expect(await h.run(['new', 'demo', '--example', name])).toBe(1);
      expect(h.err.text()).toContain(reason);
    }
  });
  it('does not write even when a late download fails, with URL and closest-template guidance', async () => {
    for (const failure of [
      new Response('missing', { status: 404 }),
      new Error('offline'),
      'offline',
    ]) {
      let calls = 0;
      const fetchFile: typeof fetch = (input, options) => {
        calls++;
        if (calls < 3) return repositoryFetch(input, options);
        return failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure);
      };
      const h = harness({}, fetchFile);
      expect(await h.run(['new', 'demo', '--example', 'minimal'])).toBe(1);
      expect(h.err.text()).toContain(
        `https://raw.githubusercontent.com/setu-ts/setu-ts/v${VERSION}/apps/minimal/package.json`,
      );
      expect(h.err.text()).toContain('setu new demo --template rest');
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.mkdirs).toEqual([]);
    }
    expect(exampleTemplate('microservices')).toBe('microservice');
  });
  it('refuses unsafe names and collisions, including dry-run collisions', async () => {
    for (const name of ['../escape', '.', 'bad\nname']) {
      const h = harness();
      expect(await h.run(['new', name, '--example', 'minimal'])).toBe(2);
      expect(h.fs.writes).toEqual([]);
    }
    for (const dry of [[], ['--dry-run']]) {
      const fetchFile = vi.fn();
      const h = harness({ '/work/demo/main.ts': 'keep me' }, fetchFile);
      expect(await h.run(['new', 'demo', '--example', 'minimal', ...dry])).toBe(1);
      expect(fetchFile).not.toHaveBeenCalled();
      expect(h.fs.read('/work/demo/main.ts')).toBe('keep me');
    }
  });
  it('reports write failures and interruptions with no completed scaffold', async () => {
    for (const failure of [new Error('disk full'), 'disk full']) {
      const h = harness();
      h.fs.writeFile = () => Promise.reject(failure);
      expect(await h.run(['new', 'demo', '--example', 'minimal'])).toBe(1);
      expect(h.err.text()).toContain('Failed to write');
    }
    const h = harness();
    expect(
      await h.run(['new', 'demo', '--example', 'minimal'], { interrupt: AbortSignal.abort() }),
    ).toBe(130);
    expect(h.fs.writes).toEqual([]);
    // Interrupted while a download is in flight: fetch rejects with its own AbortError.
    const controller = new AbortController();
    const midway = harness({}, async (_input, init) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error('aborted');
    });
    expect(
      await midway.run(['new', 'demo', '--example', 'minimal'], { interrupt: controller.signal }),
    ).toBe(130);
    expect(midway.err.text()).toContain('Interrupted; nothing was written.');
    expect(midway.err.text()).not.toContain('Failed to fetch');
    expect(midway.fs.writes).toEqual([]);
  });
  it('bounds every download with a timeout signal combined with the interrupt', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const h = harness({}, async (input, init) => {
      signals.push(init?.signal);
      return repositoryFetch(input, init);
    });
    expect(
      await h.run(['new', 'demo', '--example', 'minimal'], {
        interrupt: new AbortController().signal,
      }),
    ).toBe(0);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    const timedOut = harness({}, async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await timedOut.run(['new', 'demo', '--example', 'minimal'])).toBe(1);
    expect(timedOut.err.text()).toContain('due to timeout');
    expect(timedOut.err.text()).toContain('Nothing was written');
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });
  it('supports optional agents and the help inventory', async () => {
    const h = harness();
    expect(await h.run(['new', 'demo', '--example', 'minimal', '--agents'])).toBe(0);
    expect(h.fs.has('/work/demo/AGENTS.md')).toBe(true);
    expect(await h.run(['new', '--help'])).toBe(0);
    expect(h.out.text()).toContain('--example <app>');
  });
  it('rewrites only workspace ranges, helper import paths and README repository references', async () => {
    const source = JSON.stringify({
      name: 'old',
      dependencies: { a: 'workspace:^', b: '^1' },
      peerDependencies: { a: 'workspace:^' },
      optionalDependencies: { c: 'workspace:^' },
    });
    const manifest = JSON.parse(rewriteExamplePackage(source, 'new-name'));
    expect(manifest.dependencies).toEqual({ a: `^${VERSION}`, b: '^1' });
    expect(manifest.peerDependencies.a).toBe(`^${VERSION}`);
    expect(manifest.optionalDependencies.c).toBe(`^${VERSION}`);
    expect(JSON.parse(exampleTsconfig()).compilerOptions.types).toEqual(['node']);
    expect(rewriteExampleSource("import '../smoke-helpers.ts'; import './other.ts';")).toBe(
      "import './smoke-helpers.ts'; import './other.ts';",
    );
    expect(rewriteSmokeHelper('no loader')).toBe('no loader');
    const readme = rewriteExampleReadme(
      [
        '# rest-api',
        '',
        'Run from the repository root after installing dependencies:',
        '',
        'pnpm --dir apps/rest-api run start',
        'REDIS_URL=x pnpm --dir apps/rest-api run smoke',
        '',
        'See the [deep dive](../../docs/examples.md#rest-api) and [CLI](../../docs/cli.md).',
        '',
      ].join('\n'),
      'rest-api',
    );
    expect(readme).toContain('Run after `npm install`:');
    expect(readme).toContain('\nnpm run start\nREDIS_URL=x npm run smoke\n');
    expect(readme).toContain('](https://setu-ts.dev/docs/examples/#rest-api)');
    expect(readme).toContain('](https://setu-ts.dev/docs/cli/)');
    expect(readme).not.toMatch(/apps\/rest-api|\.\.\/\.\.\//);
    expect(readme.endsWith('Walkthrough: https://setu-ts.dev/examples/rest-api/\n')).toBe(true);
    // Every offered README comes out free of repository commands and repository-relative links.
    for (const example of EXAMPLES) {
      const text = rewriteExampleReadme(
        await readFile(new URL(`apps/${example}/README.md`, root), 'utf8'),
        example,
      );
      expect(text, example).not.toMatch(/pnpm --dir apps\/|\]\(\.\.?\//);
    }
    expect(EXAMPLE_MANIFEST.minimal.smokeHelper).toBe(false);
  });
  it('reports an agents write failure and rolls back an interrupted file batch', async () => {
    const agents = harness();
    const original = agents.fs.writeFile;
    agents.fs.writeFile = (path, bytes) =>
      path.endsWith('/AGENTS.md')
        ? Promise.reject(new Error('agents write refused'))
        : original(path, bytes);
    expect(await agents.run(['new', 'demo', '--example', 'minimal', '--agents'])).toBe(1);
    const h = harness();
    const controller = new AbortController();
    const write = h.fs.writeFile;
    h.fs.writeFile = async (path, bytes) => {
      await write(path, bytes);
      controller.abort();
    };
    expect(
      await h.run(['new', 'demo', '--example', 'minimal'], { interrupt: controller.signal }),
    ).toBe(130);
    expect(h.fs.has('/work/demo/main.ts')).toBe(false);
  });
});

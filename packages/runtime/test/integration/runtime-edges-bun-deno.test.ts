/**
 * M143i on Bun and Deno: the same server, from `test/fixtures/edge-server.ts`,
 * run in a child process per runtime. `HEAD` reaches `GET` routes (V13-113);
 * a failed response stream is logged once and the runtime prints nothing raw
 * (V13-256); a fully read stream runs its cleanup once, after the last chunk
 * (V13-200); and on Bun a stream quiet past 10 s stays open (V13-42). Each
 * arm runs only when its binary is installed. The fixture is bundled first
 * with the workspace packages taken from source, so no build is needed.
 *
 * @module
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unusedPort } from '../../../../test/node-helpers.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = fileURLToPath(new URL('../fixtures/edge-server.ts', import.meta.url));
const fixture = resolve(root, '.tmp/runtime-edge-server/edge-server.mjs');

/**
 * Bundles the fixture once: `@setu-ts/*` from each package's `src` (CI builds
 * no `dist`), other packages external at their resolved paths, so Bun and
 * Deno run one plain module.
 */
let bundled: Promise<unknown> | undefined;
function bundleFixture(): Promise<unknown> {
  bundled ??= mkdir(resolve(root, '.tmp/runtime-edge-server'), { recursive: true }).then(() =>
    build({
      entryPoints: [source],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      tsconfig: resolve(root, 'tsconfig.check.json'),
      plugins: [
        {
          name: 'source-workspace',
          setup(builder) {
            builder.onResolve({ filter: /^@setu-ts\// }, (args) => ({
              path: resolve(root, 'packages', args.path.slice('@setu-ts/'.length), 'src/index.ts'),
            }));
            builder.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.pluginData === 'resolve-external') return undefined;
              if (args.path.startsWith('node:')) return { path: args.path, external: true };
              const dependency = await builder.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: 'resolve-external',
              });
              // An optional peer that is not installed stays a bare import; the
              // runtime's guarded loader reports it if it is ever reached.
              if (dependency.errors.length > 0) return { path: args.path, external: true };
              return { path: dependency.path, external: true };
            });
          },
        },
      ],
    }),
  );
  return bundled;
}

/** Whether a binary runs here. */
function installed(binary: string): boolean {
  return spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
}

const runtimes = [
  { name: 'bun', command: 'bun', args: (port: number) => [fixture, String(port)] },
  {
    name: 'deno',
    command: 'deno',
    args: (port: number) => ['run', '-A', fixture, String(port)],
  },
].filter((runtime) => installed(runtime.command));

describe.runIf(runtimes.length > 0).each(runtimes)('M143i on $name', (runtime) => {
  let child: ChildProcess;
  let port: number;
  let stdout = '';
  let stderr = '';

  /** The JSON lines the child printed. */
  function records(): Record<string, unknown>[] {
    return stdout
      .split('\n')
      .filter((entry) => entry.startsWith('{'))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  beforeAll(async () => {
    await bundleFixture();
    port = await unusedPort();
    child = spawn(runtime.command, runtime.args(port), { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const deadline = Date.now() + 20_000;
    while (!records().some((record) => record['ready'] === true)) {
      if (Date.now() > deadline) throw new Error(`child never became ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 30_000);

  /** Polls the child's output until `ready` holds, for up to 10 s. */
  async function until(ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!ready() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  afterAll(() => {
    child.kill();
  });

  it('answers HEAD from a GET route', async () => {
    const get = await fetch(`http://127.0.0.1:${port}/doc`);
    const length = get.headers.get('content-length');
    expect(length).not.toBeNull();
    await get.text();
    const head = await fetch(`http://127.0.0.1:${port}/doc`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(length);
    expect(await head.text()).toBe('');
  });

  it('logs a failed stream once and prints nothing raw', async () => {
    await fetch(`http://127.0.0.1:${port}/broken`)
      .then((response) => response.text())
      .catch(() => undefined);
    await until(() => records().some((record) => record['msg'] === 'Response stream failed'));
    expect(records().some((record) => record['msg'] === 'Response stream failed')).toBe(true);
    expect(stderr).not.toContain('source failed');
  });

  it('runs a cleanup once, after the last chunk, for a full read', async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/full`)).text()).toBe(
      'chunk 1\nchunk 2\nchunk 3\n',
    );
    await until(() => records().some((record) => record['marker'] === 'cleanup'));
    const markers = records()
      .map((record) => record['marker'])
      .filter((marker) => marker !== undefined && marker !== 'logged');
    expect(markers).toEqual(['chunk 1', 'chunk 2', 'chunk 3', 'cleanup']);
  });

  it('never reads a completed request as aborted, nor reports it aborted after the response', async () => {
    // Deno's legacy request.signal aborts once a response has been sent; the
    // request log line and the kernel's watcher must both be done by then.
    const before = records().filter((record) => record['marker'] === 'logged').length;
    await (await fetch(`http://127.0.0.1:${port}/full`)).text();
    await (await fetch(`http://127.0.0.1:${port}/doc`)).text();
    await until(
      () => records().filter((record) => record['marker'] === 'logged').length >= before + 2,
    );
    const mine = records()
      .filter((record) => record['marker'] === 'logged')
      .slice(before);
    expect(mine.map((record) => record['path'])).toEqual(['/full', '/doc']);
    expect(mine.every((record) => record['aborted'] === false)).toBe(true);
    // Deno's legacy signal aborts after the response: give it time to.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      records().filter((record) => record['msg'] === 'Request aborted before completion'),
    ).toEqual([]);
  });

  it.runIf(runtime.name === 'bun')(
    'keeps a stream open through 12 s of silence',
    async () => {
      const text = await (await fetch(`http://127.0.0.1:${port}/quiet`)).text();
      expect(text).toBe('open\nstill here\n');
    },
    20_000,
  );
});

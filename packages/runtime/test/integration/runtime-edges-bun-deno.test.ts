/**
 * M143i on Bun and Deno: the same server, from `test/fixtures/edge-server.ts`,
 * run in a child process per runtime. `HEAD` reaches `GET` routes (V13-113);
 * a failed response stream is logged once and the runtime prints nothing raw
 * (V13-256); a fully read stream runs its cleanup once, after the last chunk
 * (V13-200); and on Bun a stream quiet past 10 s stays open (V13-42). Each
 * arm runs only when its binary is installed; the kernel is read from its
 * build, so run after `pnpm run check`.
 *
 * @module
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unusedPort } from '../../../../test/node-helpers.ts';

const fixture = fileURLToPath(new URL('../fixtures/edge-server.ts', import.meta.url));

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

  afterAll(() => {
    child.kill();
  });

  it('answers HEAD from a GET route', async () => {
    const get = await fetch(`http://127.0.0.1:${port}/doc`);
    const length = get.headers.get('content-length');
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(records().some((record) => record['msg'] === 'Response stream failed')).toBe(true);
    expect(stderr).not.toContain('source failed');
  });

  it('runs a cleanup once, after the last chunk, for a full read', async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/full`)).text()).toBe(
      'chunk 1\nchunk 2\nchunk 3\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const markers = records()
      .map((record) => record['marker'])
      .filter((marker) => marker !== undefined);
    expect(markers).toEqual(['chunk 1', 'chunk 2', 'chunk 3', 'cleanup']);
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

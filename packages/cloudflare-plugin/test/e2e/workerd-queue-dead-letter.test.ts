/**
 * Exhausted Workers jobs on real workerd (V13-197).
 *
 * One `wrangler dev` session runs `fixtures/workerd-queue`: a Worker producing
 * to and consuming `jobs` with `max_retries = 3`, the adapter's dead-letter
 * producer `jobs-dlq`, and the platform's `dead_letter_queue`
 * `jobs-platform-dlq`, both consumed into memory and read back over HTTP.
 *
 * Guarded like the CLI's Workers tests: skipped off CI when the `wrangler`
 * binary cannot run, failed on CI. Production consumer concurrency is not
 * provable here (no Cloudflare account).
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'workerd-queue');
const wrangler = join(here, '..', '..', 'node_modules', '.bin', 'wrangler');

const onCi = process.env['CI'] === 'true';
const hasWrangler = spawnSync(wrangler, ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !hasWrangler && !onCi;

const CASE_TIMEOUT_MS = 120_000;

interface State {
  readonly deliveries: Record<string, number>;
  readonly onFailed: Record<string, number>;
  readonly adapterDlq: { id?: string; attempts?: number; error?: string; data?: unknown }[];
  readonly platformDlq: unknown[];
}

let dev: ChildProcess | undefined;
let output = '';
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function add(query: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/add?${query}`, { method: 'POST' });
  return ((await response.json()) as { id: string }).id;
}

async function state(): Promise<State> {
  return (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as State;
}

/** Polls the fixture state until `check` holds. */
async function settled(check: (s: State) => boolean, what: string): Promise<State> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const current = await state();
    if (check(current)) return current;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${JSON.stringify(current)}`);
    await sleep(250);
  }
}

describe.skipIf(skip)('exhausted Workers jobs on workerd (V13-197)', () => {
  beforeAll(async () => {
    port = await freePort();
    dev = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: fixture,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    dev.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    dev.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const deadline = Date.now() + 90_000;
    while (!output.includes('Ready on')) {
      if (Date.now() > deadline) throw new Error(`wrangler dev:\n${output.slice(-3000)}`);
      await sleep(100);
    }
  }, CASE_TIMEOUT_MS);

  afterAll(() => {
    if (dev?.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  });

  it(
    'maxAttempts 2: onFailed once, then the job reaches the dead-letter queue with its payload',
    async () => {
      const id = await add('mode=always&maxAttempts=2');
      const s = await settled((x) => x.adapterDlq.some((m) => m.id === id), 'dead-letter copy');
      expect(s.onFailed[id]).toBe(1);
      expect(s.deliveries[id]).toBe(2);
      expect(s.adapterDlq.find((m) => m.id === id)).toMatchObject({
        data: { mode: 'always' },
        attempts: 2,
        error: 'Error: fails on attempt 2',
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'maxAttempts 9 is capped at max_retries, and the job still reaches the dead-letter queue',
    async () => {
      const id = await add('mode=always&maxAttempts=9');
      const s = await settled((x) => x.adapterDlq.some((m) => m.id === id), 'capped copy');
      expect(s.deliveries[id]).toBe(3);
      expect(s.onFailed[id]).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a refused dead-letter send is retried on the reserve delivery, with onFailed still once',
    async () => {
      const id = await add('mode=always&arm=flaky');
      const s = await settled((x) => x.adapterDlq.some((m) => m.id === id), 'reserve copy');
      const copy = s.adapterDlq.find((m) => m.id === id);
      expect(s.deliveries[id]).toBe(3);
      expect(s.onFailed[id]).toBe(1);
      expect(copy?.attempts).toBe(4);
      expect(copy).not.toHaveProperty('error');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'deadLetterQueue false: onFailed once, and no dead-letter queue receives the job',
    async () => {
      const id = await add('mode=always&arm=discard');
      const s = await settled((x) => x.onFailed[id] === 1, 'discard');
      await sleep(3000);
      const after = await state();
      expect(s.deliveries[id]).toBe(3);
      expect(after.adapterDlq.some((m) => m.id === id)).toBe(false);
      expect(after.platformDlq).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'control: a job that fails once succeeds on its retry and reaches no dead-letter queue',
    async () => {
      const id = await add('mode=once');
      const s = await settled((x) => x.deliveries[id] === 2, 'retry');
      await sleep(2000);
      const after = await state();
      expect(s.onFailed[id]).toBeUndefined();
      expect(after.adapterDlq.some((m) => m.id === id)).toBe(false);
      expect(after.platformDlq).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

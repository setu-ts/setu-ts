/**
 * Real Redis outage for the scheduler's distributed lock (M101a V8-24),
 * through a real kernel app.
 *
 * `docker pause` freezes Redis while its socket stays open, so ioredis sees
 * neither an error nor a close. Before this letter a lock `SET` against it
 * waited forever, so every fire of every job parked silently: no handler ran,
 * nothing was logged, and the diagnostics recorded nothing, because a fire is
 * recorded only when it settles. With `acquireTimeoutMs: 500` each paused fire
 * settles `lock-failed` inside the bound, and after unpause the job dispatches
 * again.
 *
 * Guarded with `ignore:` on `REDIS_URL` (never an early return, so an unset
 * variable is reported as IGNORED rather than passing). CI sets it and runs
 * Redis as a service container; `test/apps-gate.test.ts` pins that wiring. The
 * container is found by its published port and unpaused on every exit.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISchedulerDiagnosticsSource, SchedulerDiagnosticsRecord } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { SchedulerPlugin } from '../../src/index.ts';
import { RedisLock } from '../../src/lock/redis-lock.ts';

const redisUrl = Deno.env.get('REDIS_URL');
const BOUND_MS = 500;

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') throw new Error(`no container publishing port ${port}`);
  return ids.split('\n')[0];
}

function target(): { url: string; port: number } {
  const url = redisUrl!.replace(/localhost/g, '127.0.0.1');
  const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
  return { url, port };
}

/** Polls `read` until `done` holds or 15 s pass; returns the last reading. */
async function waitFor<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 15_000;
  let last = read();
  while (!done(last) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = read();
  }
  return last;
}

describe(
  'REAL Redis scheduler lock outage (M101a V8-24)',
  { ignore: redisUrl === undefined },
  () => {
    it('paused Redis → fires settle lock-failed within the bound → unpaused → dispatches resume', async () => {
      const { url, port } = target();
      const containerId = await containerIdForPort(port);
      const job = `m101a-${crypto.randomUUID()}`;
      let runs = 0;

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          SchedulerPlugin({
            distributedLock: { enabled: true, storage: 'redis', url, acquireTimeoutMs: BOUND_MS },
            diagnostics: { enabled: true, alias: 'primary', jobs: { [job]: 'tick' } },
            jobs: [{
              trigger: 'every',
              name: job,
              intervalMs: 1000,
              handler: () => {
                runs++;
              },
            }],
          }),
        ],
      });
      await app.start();
      const [source] = app.services.getAll<ISchedulerDiagnosticsSource>(
        CAPABILITIES.SCHEDULER_DIAGNOSTICS,
      );
      const fire = (): SchedulerDiagnosticsRecord | undefined =>
        source.snapshot().records.find((r) => r.alias === 'tick' && r.operation === 'fire');

      let paused = false;
      try {
        // Healthy: the job dispatches.
        expect(await waitFor(() => runs, (n) => n >= 1)).toBeGreaterThanOrEqual(1);

        await docker(['pause', containerId]);
        paused = true;
        const failedBefore = fire()?.lockFailed ?? 0;
        const started = performance.now();
        const first = await waitFor(() => fire()?.lockFailed ?? 0, (n) => n > failedBefore);
        expect(first).toBeGreaterThan(failedBefore);
        // One grid interval plus the bound, with slack for scheduling.
        expect(performance.now() - started).toBeLessThan(3000);
        // And it keeps settling: the schedule was re-armed after the failure.
        const second = await waitFor(() => fire()?.lockFailed ?? 0, (n) => n > first);
        expect(second).toBeGreaterThan(first);

        await docker(['unpause', containerId]);
        paused = false;
        const runsAfter = runs;
        expect(await waitFor(() => runs, (n) => n > runsAfter)).toBeGreaterThan(runsAfter);
      } finally {
        if (paused) await docker(['unpause', containerId]).catch(() => '');
        await app.stop();
      }
    });

    it('a paused SET rejects inside the command bound and leaves no key held after unpause', async () => {
      const { url, port } = target();
      const containerId = await containerIdForPort(port);
      const lock = new RedisLock({ url, commandTimeoutMs: BOUND_MS });
      await lock.connect();
      const key = `m101a-lock-${crypto.randomUUID()}`;

      let paused = false;
      try {
        await docker(['pause', containerId]);
        paused = true;
        const started = performance.now();
        await expect(lock.acquire(key, 60_000)).rejects.toThrow('Command timed out');
        expect(performance.now() - started).toBeLessThan(BOUND_MS * 3);

        await docker(['unpause', containerId]);
        paused = false;
        // The timed-out SET was already written to the socket, so Redis applies
        // it on resume — and then the token-checked release the rejection path
        // queued behind it. The key is free: a fresh acquire wins instead of
        // waiting out the 60 s TTL.
        expect(await lock.acquire(key, 1000)).not.toBeNull();
      } finally {
        if (paused) await docker(['unpause', containerId]).catch(() => '');
        await lock.disconnect();
      }
    });
  },
);

import { run as runProcess } from '../../../../test/node-helpers.ts';
/**
 * §3.7 real-outage bar: drives a **real** Redis backend through a **real**
 * stop and restart for the Redis backplane, asserting
 * `up → (stop) down → (restart) up`, including recovery (X3-2: this arm
 * self-heals — the probe flips back to reachable once the connections are
 * ready again).
 *
 * Guarded on `REDIS_URL`: absent it, this suite skips. `ALLOW_SKIP` does not
 * apply here — that variable is read only by `scripts/check-apps.ts` and governs
 * `apps/`. What keeps this suite honest is `test/apps-gate.test.ts`, which pins
 * the service, port mapping and env var in both workflows.
 * `test/apps-gate.test.ts` pins the service, port mapping, and env var.
 *
 * F2 regression: without the bound `ping.call(client)` fix, the probe reports
 * `false` forever against a healthy Redis, so the baseline `up` assertion
 * would fail if F2 regresses.
 */
import { describe, expect, it } from 'vitest';
import type {
  IRealtimeBackplane,
  HealthReport,
  IRealtimeDiagnosticsSource,
  RealtimeDiagnosticsSnapshot,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import {
  REDIS_CLIENTS,
  redisOptions,
  nodeClient,
} from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  describe('M119b REAL paused Redis backplane readiness', () => {
    it(
      'paused Redis keeps /ready 200 with unknown reachability inside the probe bound',
      {
        skip: process.env['REDIS_URL'] === undefined,
      },
      async () => {
        const url = toIpv4(process.env['REDIS_URL']!);
        const containerId = await containerIdForPort(Number(new URL(url).port || 6379));
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            HealthPlugin({ details: true }),
            RealtimeBackplanePlugin({
              transport: 'redis',
              ...redisOptions(redisVariant, url),
              ...(redisVariant === 'ioredis' ? {} : { subscriber: nodeClient(redisVariant, url) }),
            }),
          ],
        });
        let paused = false;
        try {
          await app.start();
          const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
          await waitTrue(async () => await backplane.isHealthy!(), 'connected Redis', 15000);
          await docker(['pause', containerId]);
          paused = true;
          const started = performance.now();
          const ready = await app.inject({ method: 'GET', url: '/ready' });
          expect(performance.now() - started).toBeLessThan(3500);
          expect(ready.statusCode).toBe(200);
          expect(ready.json<HealthReport>().checks['realtime-backplane']).toMatchObject({
            status: 'up',
            data: { reachable: 'unknown' },
          });
          const cached = await app.inject({ method: 'GET', url: '/ready' });
          expect(cached.json<HealthReport>().checks['realtime-backplane'].data?.reachable).toBe(
            'unknown',
          );
        } finally {
          if (paused) await docker(['unpause', containerId]);
          await docker(['start', containerId]);
          await app.stop();
        }
      },
    );
  });

  // ── Docker stop/start helpers ───────────────────────────────────────────────

  async function docker(args: string[]): Promise<string> {
    const out = await runProcess('docker', { args });
    if (!out.success) {
      throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
    }
    return new TextDecoder().decode(out.stdout);
  }

  async function containerIdForPort(port: number): Promise<string> {
    const shard = process.env['SETU_CI_SHARD'];
    const filters = shard
      ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
      : ['--filter', `publish=${port}`];
    const ids = (await docker(['ps', '-q', ...filters])).trim();
    if (ids === '') {
      throw new Error(`no container publishing port ${port}`);
    }
    return ids.split('\n')[0];
  }

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function waitTrue(
    pred: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await wait(250);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  function toIpv4(url: string): string {
    return url.replace(/localhost/g, '127.0.0.1');
  }

  describe('REAL Redis backplane outage (§3.7)', () => {
    it(
      'up → stop → down → restart → up (X3-2 self-heals)',
      {
        skip: process.env['REDIS_URL'] === undefined,
      },
      async () => {
        const url = process.env['REDIS_URL'];
        if (url === undefined) throw new Error('Backend guard failed');

        await import('ioredis');

        const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
        const containerId = await containerIdForPort(port);

        const backplane = new RedisBackplane(
          {
            transport: 'redis',
            ...redisOptions(redisVariant, toIpv4(url)),
            ...(redisVariant === 'ioredis'
              ? {}
              : { subscriber: nodeClient(redisVariant, toIpv4(url)) }),
          },
          'outage-origin',
          'outage-topic',
        );

        try {
          await backplane.connect();
          const probe = backplane.isHealthy;
          expect(typeof probe).toBe('function');
          if (typeof probe !== 'function') return;

          // (up) baseline: F2 regression — the bound ping must report reachable.
          // Poll: the two ioredis connections settle to 'ready' asynchronously.
          await waitTrue(async () => (await probe()) === true, 'up baseline', 15_000);
          expect(await probe()).toBe(true);

          // (stop) real Redis stop → probe reports down
          await docker(['stop', containerId]);
          await waitTrue(async () => (await probe()) === false, 'down after stop', 30_000);
          expect(await probe()).toBe(false);

          // (restart) real Redis start → probe reports up again (X3-2 self-heals)
          await docker(['start', containerId]);
          await waitTrue(async () => (await probe()) === true, 'up after restart', 30_000);
          expect(await probe()).toBe(true);
        } finally {
          await backplane.close();
          await runProcess('docker', { args: ['start', containerId] });
        }
      },
    );
  });

  // ── A publish on a failed connection is reported, not lost ────────────────────

  const REDIS_URL = process.env['REDIS_URL'];
  /** Short enough to keep the suite fast; the default is 15 s. */
  const COMMAND_TIMEOUT_MS = 1_500;

  function publishRecord(source: IRealtimeDiagnosticsSource) {
    const snapshot: RealtimeDiagnosticsSnapshot = source.snapshot();
    return snapshot.records.find((entry) => entry.operation === 'backplane-publish');
  }

  /** Settles `promise` or reports that it was still pending after `ms`. */
  function settleWithin(promise: Promise<void>, ms: number): Promise<string> {
    const outcome = promise.then(
      () => 'resolved',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`still pending after ${ms} ms`), ms);
    });
    return Promise.race([outcome, pending]).finally(() => clearTimeout(timer));
  }

  describe('REAL Redis backplane: a publish on a failed connection', () => {
    it(
      'rejects, is recorded failed, and publishing recovers — silent and dropped connections',
      {
        skip: REDIS_URL === undefined,
      },
      async () => {
        const port = new URL(REDIS_URL!).port === '' ? 6379 : Number(new URL(REDIS_URL!).port);
        const containerId = await containerIdForPort(port);
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            RealtimeBackplanePlugin({
              transport: 'redis',
              ...redisOptions(redisVariant, toIpv4(REDIS_URL!), COMMAND_TIMEOUT_MS),
              ...(redisVariant === 'ioredis'
                ? {}
                : { subscriber: nodeClient(redisVariant, toIpv4(REDIS_URL!), COMMAND_TIMEOUT_MS) }),
              topic: `outage-publish-${crypto.randomUUID()}`,
              commandTimeoutMs: COMMAND_TIMEOUT_MS,
              diagnostics: { enabled: true, alias: 'fanout' },
            }),
          ],
        });
        await app.start();
        const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
        const [source] = app.services.getAll<IRealtimeDiagnosticsSource>(
          CAPABILITIES.REALTIME_DIAGNOSTICS,
        );
        const frame = { kind: 'ws-room' as const, origin: 'x', name: 'lobby', data: 'hi' };
        let paused = false;
        try {
          // The first command on a loaded runner can outlast the short command
          // bound before anything is paused (seen once on CI as an unattributed
          // `Command timed out`), so the baseline waits for one publish to land.
          await waitTrue(
            () => settleWithin(backplane.publish(frame), 3_000).then((r) => r === 'resolved'),
            'baseline publish',
            30_000,
          );
          const baseline = publishRecord(source!)!;
          expect(baseline.succeeded).toBeGreaterThanOrEqual(1);

          // (1) SILENT: the socket stays open while the server answers nothing — a
          // paused or partitioned host that sends no reset. Before the command
          // timeout this publish never settled, so no consumer logged it and no
          // observation was ever recorded.
          await docker(['pause', containerId]);
          paused = true;
          const silent = await settleWithin(backplane.publish(frame), COMMAND_TIMEOUT_MS * 4);
          expect(silent).toBe('rejected: Command timed out');
          expect(publishRecord(source!)).toMatchObject({
            succeeded: baseline.succeeded,
            failed: baseline.failed + 1,
          });
          expect(publishRecord(source!)!.lastDurationMs).toBeGreaterThanOrEqual(
            COMMAND_TIMEOUT_MS - 50,
          );
          await docker(['unpause', containerId]);
          paused = false;
          await waitTrue(
            () => settleWithin(backplane.publish(frame), 3_000).then((r) => r === 'resolved'),
            'publish after unpause',
            30_000,
          );

          // (2) DROPPED: the server is stopped, so the connection closes and ioredis
          // reconnects. A publish is queued, then rejected — here by the command
          // timeout, which starts when the command is queued.
          const before = publishRecord(source!)!;
          await docker(['stop', containerId]);
          const dropped = await settleWithin(backplane.publish(frame), COMMAND_TIMEOUT_MS * 4);
          expect(dropped).toBe('rejected: Command timed out');
          expect(publishRecord(source!)).toMatchObject({ failed: before.failed + 1 });

          // Restarted, the same connections carry the next publish.
          await docker(['start', containerId]);
          await waitTrue(
            () => settleWithin(backplane.publish(frame), 3_000).then((r) => r === 'resolved'),
            'publish after restart',
            30_000,
          );
          expect(publishRecord(source!)!.succeeded).toBeGreaterThan(before.succeeded);
        } finally {
          if (paused) {
            await runProcess('docker', { args: ['unpause', containerId] });
          }
          await runProcess('docker', { args: ['start', containerId] });
          await app.stop();
        }
      },
    );
  });
});

import { run as runProcess } from '../../../../test/node-helpers.ts';
/**
 * Real MongoDB outage gate (M95b §3.5 / X51-1).
 *
 * X51-1 is the milestone's second High: `DatabaseService.isHealthy()` read
 * the lifecycle `adapter.isReady()`, so a stopped database reported `up`,
 * `/ready` answered `200`, and a rolling deploy rolled forward over a pod
 * that answered `500` to every request touching data. This suite is the
 * reproduction as a gate: a real kernel application with the real plugin,
 * the real Mongo driver and the real HealthPlugin, driven through a real
 * `docker stop`/`start`, asserting the sequence the deployment actually
 * depends on — `/ready` answers `200`, then **`503`** with the container
 * stopped, then `200` after restart. The plan's bar for the stopped cell is
 * "`/ready` must answer 503 and the indicator must not say `up`" — whether
 * the refused backend surfaces as `down` or as `degraded` (a probe that
 * cannot answer inside the bound), both already fail `/ready`.
 *
 * Guarded on the Mongo URL (`MONGODB_URL`, falling back to the `MONGO_URL`
 * /`MONGODB_URI` names the M78 suite and CI use); absent it the suite is
 * declared with the BDD `ignore` option rather than an early return, so an
 * unset variable is reported as **ignored**, not as a pass that exercised
 * nothing. Container discovery mirrors the messaging outage suite:
 * `docker ps --filter publish=<port>` locates the backend by its published
 * port, so the same suite works against the CI service container and a
 * local `he-mongo` alike.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { DatabasePlugin } from '../../src/index.ts';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  DrizzleAdapter,
  createDrizzleDatabase,
  DatabaseService,
  DatabaseTimeoutError,
  DatabaseUnavailableError,
} from '../../src/index.ts';

const postgresUrl = process.env['POSTGRES_URL'];

describe('M113g REAL paused PostgreSQL driver bounds', { skip: postgresUrl === undefined }, () => {
  it('bounds open and new connection reads, recovers, and records transaction latency', async () => {
    const parsed = new URL(postgresUrl!);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55432')
      throw new Error('M113g pause proof requires the owned throwaway PostgreSQL on port 55432.');
    const containerId = await containerIdForPort(55432);
    if ((await docker(['inspect', '--format', '{{.Name}}', containerId])).trim() !== '/m113g-pg')
      throw new Error('M113g pause proof refuses a container it does not own.');
    const pool = new Pool({
      connectionString: postgresUrl!,
      query_timeout: 1000,
      connectionTimeoutMillis: 1000,
    });
    const tableName = `m113g_bounds_${crypto.randomUUID().replaceAll('-', '')}`;
    const table = pgTable(tableName, { id: text('id').primaryKey() });
    const database = drizzle(pool);
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(database, (db, work) => db.transaction(work)),
      drizzleTables: { Measurement: table },
    });
    const service = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'drizzle',
    );
    let paused = false;
    let scheduledUnpause: Promise<void> = Promise.resolve();
    const measurements: Record<string, unknown> = {};
    const timedReject = async (
      label: string,
      operation: () => Promise<unknown>,
    ): Promise<unknown> => {
      const start = performance.now();
      const error: unknown = await operation().catch((caught: unknown) => caught);
      measurements[label] = {
        elapsedMs: performance.now() - start,
        name: error instanceof Error ? error.name : 'not-an-error',
      };
      return error;
    };
    try {
      await pool.query(`CREATE TABLE "${tableName}" (id text primary key)`);
      await pool.query(`INSERT INTO "${tableName}" VALUES ('warm')`);
      await adapter.connect();
      const repo = service.getRepository('Measurement');
      expect(await repo.findById('warm')).toEqual({ id: 'warm' });
      await docker(['pause', containerId]);
      paused = true;
      const pauseStart = performance.now();
      expect(await timedReject('open', () => repo.findById('warm'))).toBeInstanceOf(
        DatabaseTimeoutError,
      );
      expect(await timedReject('new', () => repo.findById('warm'))).toBeInstanceOf(
        DatabaseUnavailableError,
      );
      for (const label of ['open', 'new']) {
        const elapsed = (measurements[label] as { elapsedMs: number }).elapsedMs;
        expect(elapsed).toBeGreaterThan(800);
        expect(elapsed).toBeLessThan(2500);
      }
      await wait(Math.max(0, 5200 - (performance.now() - pauseStart)));
      await docker(['unpause', containerId]);
      paused = false;
      expect(await repo.findById('warm')).toEqual({ id: 'warm' });
      expect(
        await timedReject('transaction', () =>
          service.transaction(async (uow) => {
            const scoped = uow.getRepository('Measurement');
            await scoped.findById('warm');
            await docker(['pause', containerId]);
            paused = true;
            scheduledUnpause = wait(5200).then(async () => {
              await docker(['unpause', containerId]);
              paused = false;
            });
            await scoped.findById('warm');
          }),
        ),
      ).toBeInstanceOf(DatabaseTimeoutError);
      await scheduledUnpause;
      expect(await repo.findById('warm')).toEqual({ id: 'warm' });
      process.stdout.write(`M113g PostgreSQL measurements ${JSON.stringify(measurements)}\n`);
    } finally {
      await scheduledUnpause;
      if (paused) await docker(['unpause', containerId]);
      await pool.query(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {});
      await pool.end();
    }
  });
});

const mongoUrl =
  process.env['MONGODB_URL'] ?? process.env['MONGO_URL'] ?? process.env['MONGODB_URI'];
const skipReal = mongoUrl === undefined;
const url = mongoUrl ?? '';

async function docker(args: string[]): Promise<string> {
  const out = await runProcess('docker', { args });
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

/** Finds the container ID publishing the given port (the messaging suite's shape). */
async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until the probe reports the wanted status, or the budget runs out. */
async function waitUntil(
  probe: () => Promise<number>,
  wanted: number,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await probe();
    if (last === wanted) return;
    await wait(250);
  }
  throw new Error(`timeout waiting for ${label}: last status ${last}`);
}

describe(
  'REAL MongoDB outage (M95b §3.5 / X51-1)',
  {
    skip: skipReal,
  },
  () => {
    it('ready 200 → (docker stop) ready 503 and the indicator not up → (docker start) ready 200', async () => {
      const parsed = new URL(url.replace(/localhost/, '127.0.0.1'));
      const port = parsed.port === '' ? 27017 : Number(parsed.port);
      const containerId = await containerIdForPort(port);

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          DatabasePlugin({
            type: 'mongodb',
            options: { url: url.replace(/localhost/, '127.0.0.1'), database: 'setu_m95b' },
          }),
          HealthPlugin(),
        ],
      });
      await app.start();

      // The suite owns the container's lifecycle across ALL exits: a failed
      // assertion after `docker stop` must not leave the backend down for
      // everything else that shares it.
      let stopped = false;
      try {
        const readyStatus = async (): Promise<number> =>
          (await app.inject({ method: 'GET', url: 'http://localhost/ready' })).statusCode;
        const healthBody = async (): Promise<{
          status: string;
          checks?: Record<string, { status: string }>;
        }> => (await app.inject({ method: 'GET', url: 'http://localhost/health' })).json();

        // (up) baseline — a healthy database passes readiness.
        await waitUntil(readyStatus, 200, 'baseline ready 200');
        expect((await healthBody()).status).toBe('up');

        // (stop) X51-1's reproduction: with the container stopped, the
        // lifecycle read `isReady()` still answered true — the old indicator
        // reported `up` and `/ready` stayed 200. Now `/ready` MUST fail.
        await docker(['stop', containerId]);
        stopped = true;
        await waitUntil(readyStatus, 503, 'stopped ready 503', 60_000);
        const stoppedHealth = await healthBody();
        expect(stoppedHealth.status).not.toBe('up');
        // The database check reports WHY: either the probe answered false
        // (refused) or it could not answer inside the bound (unknown).
        const dbCheck = stoppedHealth.checks?.database ?? stoppedHealth.checks?.['database'];
        if (dbCheck !== undefined) {
          expect(['down', 'degraded']).toContain(dbCheck.status);
        }

        // (restart) the backend returns and readiness recovers. The flag is
        // cleared only HERE — after the container is actually back — so every
        // assertion above exits through the `finally` with it still set. It
        // used to be cleared the moment the 503 arrived, which left the three
        // assertions in between able to strand the container for everything
        // else that shares it, contradicting the comment above.
        await docker(['start', containerId]);
        stopped = false;
        await waitUntil(readyStatus, 200, 'recovered ready 200', 60_000);
        expect((await healthBody()).status).toBe('up');
      } finally {
        if (stopped) {
          await docker(['start', containerId]).catch(() => {});
        }
        await app.stop().catch(() => {});
      }
    });
  },
);

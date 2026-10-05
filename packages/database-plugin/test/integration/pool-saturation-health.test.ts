/**
 * M101a V8-3 — a saturated pool keeps `/ready` at 200.
 *
 * Before this letter, a Drizzle probe queued its `SELECT 1` behind a
 * saturated pool, timed out at the 2 s bound, and the indicator answered
 * `degraded` — `/ready` 503 on every replica that was merely busy, the
 * cascading-failure shape. Saturation is data (M90b), so the indicator now
 * answers `up` with `reachable: 'unknown'` and the capacity beside it —
 * provided queries are still completing. A hung database behind a full pool
 * shows the same capacity snapshot and stops completing queries, so it reads
 * `degraded` and `/ready` fails, as an outage must.
 *
 * A real Drizzle instance over the `pg-proxy` driver (the real SQL
 * generator, a controllable transport, no server) inside a real kernel app
 * with the real HealthPlugin. Once the test saturates it, the transport BLOCKS
 * every query, so a probe that is run at all never answers: the saturated cell
 * can only pass because no `SELECT 1` was queued. The no-`poolStats` cell pins the documented
 * limit — without the snapshot the adapter cannot see saturation, and an
 * unanswered probe stays `degraded`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '../../src/index.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import type { DatabasePoolCapacity } from '../../src/interfaces/index.ts';
import { createDrizzleDatabase, DatabasePlugin } from '../../src/index.ts';

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
});

interface DatabaseCheck {
  status: string;
  data?: { reachable?: unknown; capacity?: DatabasePoolCapacity };
}

async function boot(poolStats?: () => DatabasePoolCapacity) {
  const queries: string[] = [];
  const releases: Array<() => void> = [];
  let hang = false;
  // While `hang` is set every query blocks until the test releases it — the
  // transport of a pool with no free connection, or of a database that has
  // stopped answering. Until then queries answer at once.
  const database = drizzle((sql) => {
    queries.push(sql);
    if (!hang) {
      return Promise.resolve({ rows: [] });
    }
    return new Promise((resolve) => {
      releases.push(() => resolve({ rows: [] }));
    });
  });
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({
        type: 'drizzle',
        options: {
          drizzleInstance: createDrizzleDatabase(
            database,
            (instance, work) => instance.transaction(work),
          ),
          drizzleTables: { Tenant: tenants },
          ...(poolStats !== undefined && { poolStats }),
        },
      }),
      HealthPlugin(),
    ],
  });
  await app.start();
  return {
    app,
    queries,
    /** Completes one repository read, then makes every later query block. */
    async serveThenBlock(): Promise<void> {
      const service = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      await service.getRepository('Tenant').findAll();
      hang = true;
    },
    block(): void {
      hang = true;
    },
    async stop(): Promise<void> {
      for (const release of releases) release();
      await app.stop();
    },
  };
}

async function read(app: Awaited<ReturnType<typeof boot>>['app']) {
  const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
  const ready = await app.inject({ method: 'GET', url: 'http://localhost/ready' });
  const body = health.json() as { checks?: Record<string, DatabaseCheck> };
  return {
    health: health.statusCode,
    ready: ready.statusCode,
    database: body.checks?.['database'],
  };
}

describe('database indicator under pool saturation (M101a V8-3)', () => {
  it('reports up with reachable unknown and the capacity, keeping /ready at 200', async () => {
    const booted = await boot(() => ({ total: 3, idle: 0, waiting: 5 }));
    try {
      await booted.serveThenBlock();
      const { health, ready, database } = await read(booted.app);

      expect(health).toBe(200);
      expect(database?.status).toBe('up');
      expect(database?.data?.reachable).toBe('unknown');
      expect(database?.data?.capacity?.waiting).toBeGreaterThan(0);
      expect(ready).toBe(200);
      // The probe joined no queue: nothing reached the blocked transport.
      expect(booted.queries).not.toContain('SELECT 1');
    } finally {
      await booted.stop();
    }
  });

  it('a full pool whose queries never complete is a hung database: degraded, /ready 503', async () => {
    const booted = await boot(() => ({ total: 3, idle: 0, waiting: 5 }));
    booted.block();
    try {
      const { ready, database } = await read(booted.app);

      expect(database?.status).toBe('degraded');
      expect(database?.data?.reachable).toBe('unknown');
      expect(database?.data?.capacity?.waiting).toBeGreaterThan(0);
      expect(ready).toBe(503);
    } finally {
      await booted.stop();
    }
  });

  it('without poolStats an unanswered probe stays degraded and fails /ready (the documented limit)', async () => {
    const booted = await boot();
    booted.block();
    try {
      const { ready, database } = await read(booted.app);

      expect(database?.status).toBe('degraded');
      expect(database?.data?.reachable).toBe('unknown');
      expect(ready).toBe(503);
    } finally {
      await booted.stop();
    }
  });
});

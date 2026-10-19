import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { createNodeRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { createMigrationLedger, DatabasePlugin } from '../../src/index.ts';
import type { DatabaseReadinessOptions, IDatabaseService } from '../../src/index.ts';

async function boot(readiness?: DatabaseReadinessOptions) {
  const runtime = createNodeRuntimeServices();
  let now = 0;
  vi.spyOn(runtime, 'hrtime').mockImplementation(() => now);
  const app = createApplication({
    plugins: [
      RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } }),
      DatabasePlugin(readiness === undefined ? undefined : { readiness }),
      HealthPlugin({ details: true }),
    ],
  });
  await app.start();
  return {
    app,
    advance: () => {
      now += 5000;
    },
  };
}

describe('migration readiness through a running application', () => {
  it('keeps a connection down when it closes while the ledger read is in flight', async () => {
    const { app } = await boot({ migrations: ['one'] });
    const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const repository = database.getRepository('setu_migrations');
    let release!: (rows: Record<string, unknown>[]) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rows = new Promise<Record<string, unknown>[]>((resolve) => {
      release = resolve;
    });
    vi.spyOn(database, 'getRepository').mockReturnValue(repository);
    vi.spyOn(repository, 'findAll').mockImplementation(() => {
      entered();
      return rows;
    });
    try {
      const response = app.inject({ method: 'GET', url: '/health' });
      await reading;
      await database.close();
      release([]);
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(result.json()).toMatchObject({
        checks: {
          database: {
            status: 'down',
            data: { adapter: 'memory', name: 'default' },
          },
        },
      });
      const body = result.json() as { checks: { database: { data: object } } };
      expect(body.checks.database.data).not.toHaveProperty('migrations');
    } finally {
      release([]);
      await app.stop();
    }
  });

  it('pending keeps health 200 and readiness 503; same-process writes yield ready; unknown names keep ready', async () => {
    const { app, advance } = await boot({ migrations: ['one', 'two'] });
    try {
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const ledger = createMigrationLedger(
        app.services.get<IDatabaseService>(CAPABILITIES.DATABASE),
      );
      await ledger.record('one', 'now');
      await ledger.record('two', 'now');
      advance();
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
      await ledger.record('future', 'now');
      advance();
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it('absent readiness preserves the exact database health data', async () => {
    const { app } = await boot();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        checks: { database: { status: 'up', data: { adapter: 'memory', name: 'default' } } },
      });
      const body = response.json() as { checks: { database: { data: object } } };
      expect(body.checks.database.data).toEqual({
        adapter: 'memory',
        name: 'default',
        reachable: true,
      });
    } finally {
      await app.stop();
    }
  });
});

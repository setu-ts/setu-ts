/**
 * M101a V8-3 — the Drizzle reachability probe tells pool saturation from an
 * outage.
 *
 * A saturated pool (every connection busy, callers waiting) is DATA, not an
 * outage: the probe must neither queue a `SELECT 1` behind it nor answer
 * `false`. It rejects instead, so `DatabaseService.reachability()` reports
 * `undefined`, and the indicator reads the capacity snapshot to decide.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import type { DatabasePoolCapacity } from '../../src/interfaces/index.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase, DatabaseService } from '../../src/index.ts';
import { isPoolExhaustion } from '../../src/errors/classify.ts';
import { isSaturated, PoolSaturatedProbeSkipped } from '../../src/health/database-capacity.ts';

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
});

/** The exact text node-postgres rejects with when `connectionTimeoutMillis` elapses. */
const POOL_TIMEOUT = 'timeout exceeded when trying to connect';

function makeAdapter(
  respond: (sql: string) => Promise<{ rows: unknown[] }>,
  poolStats?: () => DatabasePoolCapacity,
): { adapter: DrizzleAdapter; seen: string[] } {
  const seen: string[] = [];
  const database = drizzle((sql) => {
    seen.push(sql);
    return respond(sql);
  });
  const adapter = new DrizzleAdapter({
    drizzleInstance: createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    ),
    drizzleTables: { Tenant: tenants },
    ...(poolStats !== undefined && { poolStats }),
  });
  return { adapter, seen };
}

describe('DrizzleAdapter probe under pool saturation (M101a V8-3)', () => {
  it('does not queue a SELECT 1 behind a saturated pool, and rejects instead of answering false', async () => {
    const { adapter, seen } = makeAdapter(
      () => Promise.resolve({ rows: [] }),
      () => ({ total: 3, idle: 0, waiting: 4 }),
    );
    await adapter.connect();

    await expect(adapter.isHealthy!()).rejects.toBeInstanceOf(PoolSaturatedProbeSkipped);
    expect(seen).toEqual([]);
  });

  it('runs the SELECT 1 when the pool has idle capacity', async () => {
    const { adapter, seen } = makeAdapter(
      () => Promise.resolve({ rows: [] }),
      () => ({ total: 3, idle: 1, waiting: 0 }),
    );
    await adapter.connect();

    expect(await adapter.isHealthy!()).toBe(true);
    expect(seen).toContain('SELECT 1');
  });

  it('runs the SELECT 1 when every connection is busy but nobody is waiting', async () => {
    const { adapter, seen } = makeAdapter(
      () => Promise.resolve({ rows: [] }),
      () => ({ total: 3, idle: 0, waiting: 0 }),
    );
    await adapter.connect();

    expect(await adapter.isHealthy!()).toBe(true);
    expect(seen).toContain('SELECT 1');
  });

  it('rethrows a pool-exhaustion rejection rather than mapping it to false', async () => {
    // drizzle-orm 0.45 wraps the driver rejection in its own query error,
    // with the driver error as `cause` — which is why the match walks the
    // chain rather than reading the top-level message.
    const { adapter } = makeAdapter(() => Promise.reject(new Error(POOL_TIMEOUT)));
    await adapter.connect();

    const rejection = await adapter.isHealthy!().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(isPoolExhaustion(rejection)).toBe(true);
  });

  it('rethrows exhaustion wrapped in a cause chain', async () => {
    const wrapped = new Error('pool failure', { cause: new Error(POOL_TIMEOUT) });
    const { adapter } = makeAdapter(() => Promise.reject(wrapped));
    await adapter.connect();

    const rejection = await adapter.isHealthy!().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isPoolExhaustion(rejection)).toBe(true);
  });

  it('still answers false for a refused connection, so an outage reads as a fact', async () => {
    const { adapter } = makeAdapter(
      () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      () => ({ total: 3, idle: 1, waiting: 0 }),
    );
    await adapter.connect();

    expect(await adapter.isHealthy!()).toBe(false);
  });

  it('reports a skipped probe as undefined through the service, never false', async () => {
    const { adapter } = makeAdapter(
      () => Promise.resolve({ rows: [] }),
      () => ({ total: 3, idle: 0, waiting: 2 }),
    );
    await adapter.connect();
    const service = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'drizzle',
    );

    expect(await service.reachability()).toBeUndefined();
  });
});

describe('isPoolExhaustion', () => {
  const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ['the anchor itself', new Error(POOL_TIMEOUT), true],
    ['the anchor one cause deep', new Error('outer', { cause: new Error(POOL_TIMEOUT) }), true],
    ['a refused connection', new Error('connect ECONNREFUSED'), false],
    ['a non-error value', 'timeout', false],
    ['null', null, false],
  ];
  for (const [label, value, expected] of cases) {
    it(`${expected ? 'matches' : 'does not match'} ${label}`, () => {
      expect(isPoolExhaustion(value)).toBe(expected);
    });
  }

  it('terminates on a cyclic cause chain', () => {
    const cyclic = new Error('loop') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isPoolExhaustion(cyclic)).toBe(false);
  });
});

describe('isSaturated', () => {
  const cases: ReadonlyArray<readonly [DatabasePoolCapacity, boolean]> = [
    [{ total: 3, idle: 0, waiting: 1 }, true],
    [{ total: 3, idle: 0, waiting: 0 }, false],
    [{ total: 3, idle: 1, waiting: 5 }, false],
  ];
  for (const [capacity, expected] of cases) {
    it(`${JSON.stringify(capacity)} → ${expected}`, () => {
      expect(isSaturated(capacity)).toBe(expected);
    });
  }
});

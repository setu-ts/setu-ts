import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthCheckResult, ProbeTiming } from '@setu-ts/common';
import {
  createMigrationLedger,
  DatabasePlugin,
  DatabaseService,
  MemoryAdapter,
} from '../../src/index.ts';
import {
  createMigrationReadiness,
  validateMigrationReadiness,
} from '../../src/migrations/migration-readiness.ts';

afterEach(() => vi.useRealTimers());

async function setup(migrations: readonly string[] = ['one'], ledgerEntity?: string) {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const database = new DatabaseService(
    adapter,
    (entity) => adapter.createDataSource(entity),
    'memory',
  );
  let now = 0;
  const timing: ProbeTiming = {
    hrtime: () => now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const evaluate = createMigrationReadiness(
    database,
    {
      migrations,
      ...(ledgerEntity === undefined ? {} : { ledgerEntity }),
    },
    timing,
  );
  return {
    database,
    evaluate,
    advance: () => {
      now += 5000;
    },
  };
}

const up: HealthCheckResult = { status: 'up', data: { adapter: 'memory' } };

describe('migration readiness', () => {
  it('pending → degraded; default ledger agreement; one read per TTL', async () => {
    const { database, evaluate, advance } = await setup();
    const repository = database.getRepository('setu_migrations');
    vi.spyOn(database, 'getRepository').mockReturnValue(repository);
    const read = vi.spyOn(repository, 'findAll');
    expect(await evaluate(up)).toEqual({
      status: 'degraded',
      data: { adapter: 'memory', migrations: { state: 'pending', pending: 1 } },
    });
    await createMigrationLedger(database).record('one', 'now');
    expect((await evaluate(up)).status).toBe('degraded');
    expect(read).toHaveBeenCalledTimes(1);
    advance();
    expect(await evaluate(up)).toEqual({
      status: 'up',
      data: { adapter: 'memory', migrations: { state: 'current', applied: 1 } },
    });
    expect(read).toHaveBeenCalledTimes(2);
    await database.close();
  });

  it.each(['up', 'degraded'] as const)(
    'unknown names keep %s status and expose only counts',
    async (status) => {
      const { database, evaluate } = await setup(['one'], 'history');
      const ledger = createMigrationLedger(database, { entity: 'history' });
      await ledger.record('one', 'now');
      await ledger.record('future-secret-name', 'now');
      expect(await evaluate({ ...up, status })).toEqual({
        status,
        data: { adapter: 'memory', migrations: { state: 'current', applied: 2, unknown: 1 } },
      });
      await database.close();
    },
  );

  it('empty expected set is current and down bypasses ledger reads with unknown migrations', async () => {
    const { database, evaluate } = await setup([]);
    const read = vi.spyOn(database, 'getRepository');
    const down: HealthCheckResult = { status: 'down', data: { reachable: false } };
    expect(await evaluate(down)).toEqual({
      ...down,
      data: { ...down.data, migrations: { state: 'unknown' } },
    });
    expect(read).not.toHaveBeenCalled();
    expect(await evaluate(up)).toEqual({
      status: 'up',
      data: { adapter: 'memory', migrations: { state: 'current', applied: 0 } },
    });
    await database.close();
  });

  it.each<HealthCheckResult>([
    { status: 'down' },
    { status: 'down', data: { reachable: true, reason: 'lifecycle' } },
    { status: 'degraded', data: { reachable: 'unknown', pool: 'saturated' } },
    { status: 'up', data: { reachable: 'unknown' } },
    { status: 'up', data: { reachable: false } },
  ])('skips ledger while reachability is unavailable (%j)', async (input) => {
    const { database, evaluate } = await setup();
    const read = vi.spyOn(database, 'getRepository');
    try {
      expect(await evaluate(input)).toEqual({
        ...input,
        data: { ...input.data, migrations: { state: 'unknown' } },
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await database.close();
    }
  });

  it.each([undefined, true])('still reads ledger with reachable %s', async (reachable) => {
    const { database, evaluate } = await setup();
    const read = vi.spyOn(database, 'getRepository');
    try {
      const input: HealthCheckResult = {
        status: 'up',
        ...(reachable === undefined ? {} : { data: { reachable } }),
      };
      expect(await evaluate(input)).toMatchObject({
        status: 'degraded',
        data: { migrations: { state: 'pending', pending: 1 } },
      });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it.each(['reject', 'oversized', 'hang'] as const)('unreadable on %s', async (mode) => {
    vi.useFakeTimers();
    const { database, evaluate } = await setup();
    const repository = database.getRepository('setu_migrations');
    vi.spyOn(database, 'getRepository').mockReturnValue(repository);
    const read = vi.spyOn(repository, 'findAll');
    if (mode === 'reject') read.mockRejectedValue(new Error('secret table'));
    if (mode === 'oversized')
      read.mockResolvedValue(Array.from({ length: 10_001 }, (_, i) => ({ id: String(i) })));
    if (mode === 'hang') read.mockImplementation(() => new Promise(() => {}));
    const result = evaluate(up);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({
      status: 'down',
      data: { adapter: 'memory', migrations: { state: 'unreadable' } },
    });
    await database.close();
  });

  it.each([null, 'secret', {}, [''], [' '], ['secret', 'secret'], [42], Array(10_001).fill('x')])(
    'validates migrations at plugin construction without echo',
    (migrations) => {
      expect(() =>
        DatabasePlugin({ readiness: { migrations: migrations as readonly string[] } }),
      ).toThrow('readiness.migrations must be an array of unique non-empty strings, at most 10000');
    },
  );
  it.each(['', ' ', 42])('validates ledgerEntity at construction', (ledgerEntity) => {
    expect(() =>
      DatabasePlugin({ readiness: { migrations: [], ledgerEntity: ledgerEntity as string } }),
    ).toThrow('readiness.ledgerEntity must be a non-empty string');
  });
  it('accepts the boundary and valid entity', () => {
    expect(() =>
      DatabasePlugin({
        readiness: {
          migrations: Array.from({ length: 10_000 }, (_, i) => String(i)),
          ledgerEntity: 'history',
        },
      }),
    ).not.toThrow();
  });

  // Audit F2: the options are read once and a frozen copy is what register() uses.
  describe('reads the options once and keeps a frozen copy', () => {
    const failure =
      'readiness.migrations must be an array of unique non-empty strings, at most 10000';

    it('ignores a getter that answers differently after validation', () => {
      let reads = 0;
      const options = {
        get migrations(): readonly string[] {
          reads += 1;
          return reads === 1 ? ['a'] : (['', ''] as readonly string[]);
        },
      };
      const copy = validateMigrationReadiness(options);
      expect(reads).toBe(1);
      expect(copy.migrations).toEqual(['a']);
      expect(Object.isFrozen(copy)).toBe(true);
      expect(Object.isFrozen(copy.migrations)).toBe(true);
    });

    it('is unaffected by mutating the caller array afterwards', () => {
      const migrations = ['a'];
      const copy = validateMigrationReadiness({ migrations });
      migrations.push('a', '');
      expect(copy.migrations).toEqual(['a']);
    });

    it('copies only the validated fields', () => {
      expect(validateMigrationReadiness({ migrations: ['a'], ledgerEntity: 'h' })).toEqual({
        migrations: ['a'],
        ledgerEntity: 'h',
      });
      expect(validateMigrationReadiness({ migrations: [] })).toEqual({ migrations: [] });
    });

    it.each([null, 'readiness', 7])('refuses a non-object readiness (%s) by name', (value) => {
      expect(() =>
        DatabasePlugin({ readiness: value as unknown as { migrations: readonly string[] } }),
      ).toThrow('readiness must be an object with a migrations array');
    });

    it('refuses a throwing getter, length, or index with its own fixed message', () => {
      const throwing = new Proxy(['a'], {
        get(target, key, receiver) {
          if (key === 'length' || key === '0') throw new Error('canary-secret');
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      for (const options of [
        {
          get migrations(): readonly string[] {
            throw new Error('canary-secret');
          },
        },
        { migrations: throwing },
      ]) {
        expect(() => validateMigrationReadiness(options)).toThrow(failure);
      }
    });
  });
});

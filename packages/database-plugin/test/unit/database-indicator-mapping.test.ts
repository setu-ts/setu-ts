/**
 * The `database` indicator's M101a mapping, as data (plan §6): each row is a
 * probe answer, a pool snapshot and a query-progress reading, and the status
 * the indicator must report for them. Driven through the `type: 'custom'` arm
 * with a fake adapter carrying the three seams the plugin feature-detects, so
 * no row depends on a Drizzle driver.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  IPluginContext,
} from '@setu-ts/common';

import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import {
  DATABASE_POOL_CAPACITY,
  DATABASE_QUERY_PROGRESS,
} from '../../src/health/database-capacity.ts';
import type { DatabasePoolCapacity } from '../../src/interfaces/index.ts';

const SATURATED: DatabasePoolCapacity = { total: 4, idle: 0, waiting: 3 };
const IDLE: DatabasePoolCapacity = { total: 4, idle: 2, waiting: 0 };

/** One mapping row: what the adapter reports, and the status it must read as. */
interface Row {
  readonly name: string;
  /** `'reject'` makes the probe produce no answer (`reachable` undefined). */
  readonly probe: boolean | 'reject';
  readonly capacity: DatabasePoolCapacity | undefined;
  /** Completed-query counts the adapter reports on successive reads. */
  readonly completed: ReadonlyArray<number | null> | undefined;
  readonly status: 'up' | 'degraded' | 'down';
  readonly reachable: true | false | 'unknown';
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: 'no answer + saturated + queries completing → up',
    probe: 'reject',
    capacity: SATURATED,
    completed: [5, 6],
    status: 'up',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + no query completed → degraded (a hung database)',
    probe: 'reject',
    capacity: SATURATED,
    completed: [0, 0],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + no progress seam → degraded',
    probe: 'reject',
    capacity: SATURATED,
    completed: undefined,
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + progress unobservable (typed seam in use) → up',
    probe: 'reject',
    capacity: SATURATED,
    completed: [null, null],
    status: 'up',
    reachable: 'unknown',
  },
  {
    name: 'no answer + idle capacity + progress unobservable → degraded',
    probe: 'reject',
    capacity: IDLE,
    completed: [null, null],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + idle capacity → degraded',
    probe: 'reject',
    capacity: IDLE,
    completed: [5, 6],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + no capacity → degraded',
    probe: 'reject',
    capacity: undefined,
    completed: [5, 6],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'refused + saturated → down (a refused probe is still a refusal)',
    probe: false,
    capacity: SATURATED,
    completed: [5, 6],
    status: 'down',
    reachable: false,
  },
  {
    name: 'answered + saturated → up',
    probe: true,
    capacity: SATURATED,
    completed: [0, 0],
    status: 'up',
    reachable: true,
  },
];

function emptySource(): IDataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve({ ...data } as Record<string, unknown>),
    update: (_id, data) => Promise.resolve({ ...data } as Record<string, unknown>),
    delete: () => Promise.resolve(true),
    count: () => Promise.resolve(0),
  };
}

/** A backend reporting exactly what a row describes. */
function adapterFor(row: Row): IDatabaseAdapter {
  const counts = [...(row.completed ?? [])];
  const adapter: IDatabaseAdapter & {
    [DATABASE_POOL_CAPACITY]?: () => DatabasePoolCapacity;
    [DATABASE_QUERY_PROGRESS]?: () => number | null;
  } = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    isHealthy: () =>
      row.probe === 'reject'
        ? Promise.reject(new Error('probe did not answer'))
        : Promise.resolve(row.probe),
    createDataSource: () => emptySource(),
    beginTransaction: (): Promise<IAdapterTransaction> =>
      Promise.resolve({
        createDataSource: () => emptySource(),
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      }),
    rawQuery: <T>(): Promise<T[]> => Promise.resolve([]),
  };
  if (row.capacity !== undefined) {
    const capacity = row.capacity;
    adapter[DATABASE_POOL_CAPACITY] = () => capacity;
  }
  if (row.completed !== undefined) {
    // Each read consumes the next count; the last one repeats.
    adapter[DATABASE_QUERY_PROGRESS] = () => counts.length > 1 ? counts.shift()! : counts[0]!;
  }
  return adapter;
}

async function indicatorFor(row: Row) {
  let indicator: (() => Promise<{ status: string; data?: Record<string, unknown> }>) | undefined;
  let clock = 0;
  const ctx = {
    services: { has: () => false, get: () => undefined, register: () => {} },
    health: {
      register: (_name: string, fn: typeof indicator) => {
        indicator = fn;
      },
    },
    lifecycle: { onClose: () => {} },
    runtime: {
      // Each read advances 1 s: well inside the 10-second progress window.
      hrtime: () => (clock += 1000),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  } as unknown as IPluginContext;
  await DatabasePlugin({ type: 'custom', adapter: adapterFor(row) }).register(ctx);
  return indicator!;
}

describe('database indicator mapping (M101a)', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const indicator = await indicatorFor(row);
      const health = await indicator();
      expect(health.status).toBe(row.status);
      expect(health.data?.['reachable']).toBe(row.reachable);
    });
  }
});

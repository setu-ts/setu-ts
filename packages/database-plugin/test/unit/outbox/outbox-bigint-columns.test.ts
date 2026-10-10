/**
 * Integer columns read back as JS `bigint` (M107b audit F1). Prisma's only
 * 64-bit integer type is `BigInt`, which Prisma Client returns as `bigint`, and
 * `claimVersion`/`leaseUntil` must be 64-bit — so a Prisma-backed outbox hands
 * the bridge `bigint` values. The relay validates them as safe integers, so the
 * bridge must convert a safe `bigint` to a number on the way out, or every row
 * would be poisoned as `invalid-row`.
 *
 * The data source here stores numbers (a memory adapter) and converts every
 * integer column to `bigint` on READ, which is what Prisma does with a numeric
 * write into a `BigInt` column.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDataSource } from '@setu-ts/common';
import { MemoryAdapter } from '../../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../../src/services/database-service.ts';
import { DatabaseOutboxStore } from '../../../src/outbox/database-outbox-store.ts';
import { ENTITY, record } from '../../fixtures/outbox-store.ts';

const INTEGERS = [
  'createdAt',
  'attempts',
  'availableAt',
  'claimVersion',
  'leaseUntil',
  'settledAt',
];

/** A row as Prisma would return it: every integer column a `bigint`. */
function asBigInts(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const field of INTEGERS) {
    if (typeof out[field] === 'number') out[field] = BigInt(out[field] as number);
  }
  return out;
}

/** A store over a memory source whose reads return integer columns as `bigint`. */
async function bigintStore(
  rows: readonly Record<string, unknown>[],
): Promise<{ store: DatabaseOutboxStore; source: IDataSource }> {
  const adapter = new MemoryAdapter();
  const source = adapter.createDataSource(ENTITY);
  for (const row of rows) await source.create({ ...row });
  const reading: IDataSource = {
    ...source,
    findAll: async (query) => (await source.findAll(query)).map(asBigInts),
    findById: async (id) => {
      const row = await source.findById(id);
      return row === null ? null : asBigInts(row);
    },
  };
  const service = new DatabaseService(adapter, () => reading, 'memory');
  return { store: new DatabaseOutboxStore(service, ENTITY), source };
}

describe('DatabaseOutboxStore — integer columns read back as bigint', () => {
  it('scanPending hands the relay numbers, not bigints', async () => {
    const { store } = await bigintStore([
      { ...record(1, { claimVersion: 3, leaseUntil: 1_700_000_030_000 }) },
    ]);
    const [row] = await store.scanPending(undefined, 10);
    for (const field of INTEGERS.filter((f) => f !== 'settledAt')) {
      expect(typeof (row as unknown as Record<string, unknown>)[field]).toBe('number');
    }
    expect(row).toMatchObject({ claimVersion: 3, leaseUntil: 1_700_000_030_000 });
    expect(Number.isSafeInteger(row!.claimVersion)).toBe(true);
  });

  it('converts the safe extremes exactly', async () => {
    const { store } = await bigintStore([
      { ...record(1, { claimVersion: Number.MAX_SAFE_INTEGER - 1 }) },
    ]);
    const [row] = await store.scanPending(undefined, 10);
    expect(row!.claimVersion).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it('converts an unsafe bigint to an unsafe number: claim fields stay refusable, the rest comparable', async () => {
    // Audit F2: an unsafe `bigint` left as a `bigint` in `createdAt` made the
    // health indicator throw (`Cannot mix BigInt and other types`). Converted,
    // it is an ordinary number; in `claimVersion` it is still not a safe
    // integer, so the relay still poisons the row.
    const adapter = new MemoryAdapter();
    const source = adapter.createDataSource(ENTITY);
    await source.create({ ...record(1) });
    const unsafe = 2n ** 62n;
    const reading: IDataSource = {
      ...source,
      findAll: async (query) =>
        (await source.findAll(query)).map((row) => ({
          ...row,
          claimVersion: unsafe,
          createdAt: unsafe,
          availableAt: unsafe,
        })),
    };
    const store = new DatabaseOutboxStore(
      new DatabaseService(adapter, () => reading, 'memory'),
      ENTITY,
    );
    const [row] = await store.scanPending(undefined, 10);
    for (const field of ['claimVersion', 'createdAt', 'availableAt'] as const) {
      expect(typeof row![field]).toBe('number');
    }
    expect(Number.isSafeInteger(row!.claimVersion)).toBe(false);
    const stats = await store.stats();
    expect(typeof stats.oldestPendingCreatedAt).toBe('number');
    // The arithmetic the health indicator performs on it no longer throws.
    expect(() => 1_700_000_000_000 - stats.oldestPendingCreatedAt!).not.toThrow();
  });

  it('a transient miss at the held version retries instead of reporting claim-lost', async () => {
    // A miss whose re-read finds the row still pending at the HELD version — Cosmos's
    // `_etag` race is the real case — must take another round. Compared as a raw
    // `bigint` against the held number, it would read as a lost claim.
    const adapter = new MemoryAdapter();
    const source = adapter.createDataSource(ENTITY);
    await source.create({ ...record(1, { claimVersion: 1 }) });
    let misses = 1;
    const reading: IDataSource = {
      ...source,
      findById: async (id) => {
        const row = await source.findById(id);
        return row === null ? null : asBigInts(row);
      },
      updateWhere: (id, where, data) => {
        if (misses > 0) {
          misses -= 1;
          return Promise.resolve(null);
        }
        return source.updateWhere!(id, where, data);
      },
    };
    const store = new DatabaseOutboxStore(
      new DatabaseService(adapter, () => reading, 'memory'),
      ENTITY,
    );
    expect(
      await store.markSent('row-1', {
        claimVersion: 1,
        settledAt: 10,
        sentBy: 'r',
        deleteNow: false,
      }),
    ).toEqual({ outcome: 'applied' });
    expect(await source.findById('row-1')).toMatchObject({ status: 'sent' });
  });

  it('classifies a real version move as claim-lost when the re-read version is a bigint', async () => {
    const { store, source } = await bigintStore([{ ...record(1, { claimVersion: 1 }) }]);
    // Another relay claimed it meanwhile: version 2.
    await source.update('row-1', { claimVersion: 2, leaseUntil: 999 });
    expect(
      await store.markSent('row-1', {
        claimVersion: 1,
        settledAt: 10,
        sentBy: 'stale',
        deleteNow: false,
      }),
    ).toEqual({ outcome: 'claim-lost' });
  });

  it('claims, marks sent, and never reports claim-lost for its own version', async () => {
    const { store, source } = await bigintStore([{ ...record(1) }]);
    const [row] = await store.scanPending(undefined, 10);
    expect(
      await store.claim('row-1', { claimVersion: row!.claimVersion, leaseUntil: 5000 }),
    ).toEqual({ outcome: 'applied' });
    expect(
      await store.markSent('row-1', {
        claimVersion: row!.claimVersion + 1,
        settledAt: 10,
        sentBy: 'r',
        deleteNow: false,
      }),
    ).toEqual({ outcome: 'applied' });
    expect(await source.findById('row-1')).toMatchObject({ status: 'sent', claimVersion: 1 });
  });
});

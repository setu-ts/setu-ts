/**
 * The `IOutboxStore` contract (M107 §3.3) as a reusable suite: what the README
 * asks of a custom store, expressed only through the port, so the same
 * assertions can run against any implementation. Internal to this repository's
 * tests — not an export.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IOutboxStore, IOutboxWriteScope, OutboxRecord } from '@setu-ts/common';
import { record } from './outbox-store.ts';

/** A fresh store and a way to run a write inside one transaction of its backend. */
export interface OutboxStoreUnderTest {
  readonly store: IOutboxStore;
  /** Runs `work` inside one transaction of the store's backend. */
  readonly inTransaction: (work: (scope: IOutboxWriteScope) => Promise<void>) => Promise<void>;
  /** Releases the backend's resources after the test; omitted when there are none. */
  readonly dispose?: () => Promise<void>;
}

/**
 * Registers the contract suite for one store implementation.
 *
 * @param name - The implementation's name, for the suite title
 * @param build - Builds a fresh, empty store under test
 * @param ignore - Skips the suite (a guarded real backend whose variable is unset)
 */
export function describeOutboxStoreContract(
  name: string,
  build: () => Promise<OutboxStoreUnderTest>,
  ignore = false,
): void {
  const made: OutboxStoreUnderTest[] = [];

  /** Builds a store and remembers it for disposal. */
  async function make(): Promise<OutboxStoreUnderTest> {
    const underTest = await build();
    made.push(underTest);
    return underTest;
  }

  /** A fresh store holding `records`, appended in one transaction. */
  async function holding(records: readonly OutboxRecord[]): Promise<IOutboxStore> {
    const { store, inTransaction } = await make();
    await inTransaction(async (scope) => {
      for (const r of records) await store.append(scope, r);
    });
    return store;
  }

  describe(`IOutboxStore contract — ${name}`, { ignore }, () => {
    afterEach(async () => {
      for (const underTest of made.splice(0)) await underTest.dispose?.();
    });

    it('verify resolves on a usable backend', async () => {
      await (await make()).store.verify();
    });

    it('scans pending rows in position order and the cursor is exclusive', async () => {
      const store = await holding([record(3), record(1), record(2)]);
      expect((await store.scanPending(undefined, 10)).map((r) => r.id)).toEqual([
        'row-1',
        'row-2',
        'row-3',
      ]);
      expect((await store.scanPending(record(2).position, 10)).map((r) => r.id)).toEqual([
        'row-3',
      ]);
    });

    it('a row transitions only from its expected status', async () => {
      const store = await holding([record(1)]);
      const sent = { settledAt: 5, sentBy: 'relay/scheduled', deleteNow: false };
      expect(await store.markSent('row-1', sent)).toEqual({ outcome: 'applied' });
      expect(await store.markSent('row-1', sent)).toEqual({
        outcome: 'not-pending',
        status: 'sent',
        sentBy: 'relay/scheduled',
      });
      expect(
        await store.markFailure('row-1', {
          attempts: 1,
          lastError: 'late',
          availableAt: 9,
          status: 'pending',
        }),
      ).toMatchObject({ outcome: 'not-pending', status: 'sent' });
      expect(await store.release('row-1', 'retry', 9)).toEqual({
        outcome: 'not-failed',
        status: 'sent',
      });
      expect(await store.scanPending(undefined, 10)).toEqual([]);
    });

    it('a failed row blocks until released, and retry returns it to pending', async () => {
      const store = await holding([record(1)]);
      await store.markFailure('row-1', {
        attempts: 10,
        lastError: 'gave up',
        availableAt: 9,
        status: 'failed',
      });
      expect(await store.failedKeys(10)).toEqual([{}]);
      expect(await store.release('row-1', 'retry', 50)).toEqual({ outcome: 'applied' });
      const [row] = await store.scanPending(undefined, 10);
      expect(row).toMatchObject({ id: 'row-1', status: 'pending', attempts: 0, availableAt: 50 });
    });

    it('an unknown id is missing for every transition', async () => {
      const store = (await make()).store;
      expect(await store.markSent('nope', { settledAt: 1, sentBy: 'r', deleteNow: false }))
        .toEqual({ outcome: 'missing' });
      expect(
        await store.markFailure('nope', {
          attempts: 1,
          lastError: 'x',
          availableAt: 1,
          status: 'failed',
        }),
      ).toEqual({ outcome: 'missing' });
      expect(await store.release('nope', 'discard', 1)).toEqual({ outcome: 'missing' });
    });

    it('stats and purge agree with the rows', async () => {
      const store = await holding([record(1), record(2), record(3)]);
      await store.markSent('row-1', { settledAt: 10, sentBy: 'r', deleteNow: false });
      await store.markFailure('row-2', {
        attempts: 10,
        lastError: 'x',
        availableAt: 1,
        status: 'failed',
      });
      expect(await store.stats()).toEqual({
        pending: 1,
        failed: 1,
        oldestPendingCreatedAt: record(3).createdAt,
      });
      expect(await store.purge(11, 10)).toBe(1);
      expect(await store.purge(11, 10)).toBe(0);
      expect(await store.stats()).toMatchObject({ pending: 1, failed: 1 });
    });
  });
}

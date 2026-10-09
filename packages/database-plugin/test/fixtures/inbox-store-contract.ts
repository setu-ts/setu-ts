/**
 * The `IInboxStore` contract (M108 §3.10) as a reusable suite: what the README
 * asks of a custom store, expressed only through the port, so the same
 * assertions can run against any implementation. Internal to this repository's
 * tests — not an export.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IInboxStore } from '@setu-ts/common';
import { idsFor, marker } from './inbox-store.ts';

/** A fresh store under test. */
export interface InboxStoreUnderTest {
  readonly store: IInboxStore;
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
export function describeInboxStoreContract(
  name: string,
  build: () => Promise<InboxStoreUnderTest>,
  ignore = false,
): void {
  const made: InboxStoreUnderTest[] = [];

  /** Builds a store and remembers it for disposal. */
  async function make(): Promise<IInboxStore> {
    const underTest = await build();
    made.push(underTest);
    return underTest.store;
  }

  describe(`IInboxStore contract — ${name}`, { ignore }, () => {
    afterEach(async () => {
      for (const underTest of made.splice(0)) await underTest.dispose?.();
    });

    it('a committed run leaves the marker, and the work saw a scope', async () => {
      const store = await make();
      let scope: unknown;
      const result = await store.run(marker('a'), (s) => {
        scope = s;
        return Promise.resolve('done');
      });
      expect(result).toBe('done');
      expect(scope).toBeDefined();
      expect((await store.find(idsFor('a').marker))?.status).toBe('processed');
    });

    it('a rejected run leaves no marker and propagates the rejection', async () => {
      const store = await make();
      const boom = new Error('handler failed');
      await expect(store.run(marker('b'), () => Promise.reject(boom))).rejects.toBe(boom);
      expect(await store.find(idsFor('b').marker)).toBeUndefined();
    });

    it('a second run for the same marker rejects and leaves the first', async () => {
      const store = await make();
      await store.run(marker('c'), () => Promise.resolve());
      await expect(store.run(marker('c', { updatedAt: 2_000 }), () => Promise.resolve()))
        .rejects.toThrow();
      expect((await store.find(idsFor('c').marker))?.updatedAt).toBe(1_000);
    });

    it('counts failures on a separate row, parks, lists, and releases', async () => {
      const store = await make();
      const ids = idsFor('d');
      const update = { consumer: 'payroll', topic: 'people.hired.v1', lastError: 'x', now: 5 };
      expect(await store.recordFailure(ids, update)).toBe(1);
      expect(await store.recordFailure(ids, { ...update, now: 6 })).toBe(2);
      expect(await store.find(ids.marker)).toBeUndefined();

      const parked = marker('d', { status: 'parked', attempts: 2, envelope: '{"id":"e"}' });
      expect(await store.park(parked)).toBe('applied');
      expect(await store.park(parked)).toBe('exists');
      expect(await store.stats()).toEqual({ parked: 1 });
      const listed = await store.parked(10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.envelope).toBeUndefined();

      const released = await store.release(ids, 'retry', 7);
      expect(released.outcome).toBe('applied');
      expect(await store.find(ids.marker)).toBeUndefined();
      expect(await store.stats()).toEqual({ parked: 0 });
      expect(await store.release(ids, 'retry', 8)).toEqual({ outcome: 'missing' });
    });

    it('purges old rows of every status, parked included, and keeps recent ones', async () => {
      const store = await make();
      await store.run(marker('e', { updatedAt: 10 }), () => Promise.resolve());
      await store.park(marker('f', { status: 'parked', updatedAt: 10, envelope: '{"x":1}' }));
      await store.park(marker('g', { status: 'parked', updatedAt: 500 }));
      expect(await store.purge(100, 10)).toBe(2);
      expect(await store.find(idsFor('e').marker)).toBeUndefined();
      // An old parked marker goes with its envelope, so the table stays bounded.
      expect(await store.find(idsFor('f').marker)).toBeUndefined();
      expect((await store.find(idsFor('g').marker))?.status).toBe('parked');
    });

    it('verify passes on a usable backend', async () => {
      const store = await make();
      await store.verify();
    });
  });
}

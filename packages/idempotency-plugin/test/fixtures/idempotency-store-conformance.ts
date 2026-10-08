/**
 * The shared idempotency-store conformance fixture (plan §3.3, §6).
 *
 * Every store runs this same suite, so the state machine has exactly one
 * behavioural definition. One `it` per §3.3 row; the two capacity rows run only
 * for `label === 'memory'`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotencyClaimRequest,
  IdempotencyClaimResult,
  IIdempotencyStore,
  IRuntimeServices,
} from '@setu-ts/common';

/** A store factory plus the clock the suite drives. */
export interface ConformanceSetup {
  /** Builds a fresh, connected store. */
  readonly make: () => Promise<IIdempotencyStore>;
  /** Advances the store's clock (a real sleep for a server-clock store). */
  readonly advance: (ms: number) => Promise<void>;
  /** The runtime the store was connected with. */
  readonly runtime: IRuntimeServices;
  /** When `true`, every test is skipped (a guarded real backend). */
  readonly ignore?: boolean;
}

/** A 64-character lower-case hex filler. */
const hex = (char: string): string => char.repeat(64);

/** A claim request with sensible defaults. */
function request(over: Partial<IdempotencyClaimRequest> = {}): IdempotencyClaimRequest {
  return {
    key: hex('a'),
    scope: hex('b'),
    fingerprint: hex('c'),
    token: 'token-1',
    leaseMs: 100,
    ttlMs: 60_000,
    ...over,
  };
}

/**
 * Runs the conformance suite against a store.
 *
 * @param label - The store kind (`'memory'`, `'redis'`, `'durable-object'`)
 * @param setup - The store factory and clock
 */
export function runIdempotencyStoreConformance(label: string, setup: ConformanceSetup): void {
  const ignore = setup.ignore ?? false;

  const claim = async (store: IIdempotencyStore, over?: Partial<IdempotencyClaimRequest>) => {
    return await store.claim(request(over));
  };

  describe(`idempotency store conformance (${label})`, () => {
    it('claims an absent key without takeover', { ignore }, async () => {
      const store = await setup.make();
      expect(await claim(store)).toEqual({ outcome: 'claimed', takeover: false });
    });

    it('answers a completed record to a matching claim', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      expect(await store.complete(hex('a'), 'token-1', 'the-record', 60_000)).toBe('settled');
      const result: IdempotencyClaimResult = await claim(store, { token: 'token-2' });
      expect(result).toEqual({ outcome: 'completed', record: 'the-record' });
    });

    it('refuses a concurrent duplicate inside the lease as in-progress', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      expect(await claim(store, { token: 'token-2' })).toEqual({ outcome: 'in-progress' });
    });

    it('takes over a lapsed lease inside the claim', { ignore }, async () => {
      const store = await setup.make();
      await claim(store, { leaseMs: 100 });
      await setup.advance(150);
      expect(await claim(store, { token: 'token-2' })).toEqual({
        outcome: 'claimed',
        takeover: true,
      });
    });

    it(
      'refuses a claim whose fingerprint differs, before the state check',
      { ignore },
      async () => {
        const store = await setup.make();
        await claim(store);
        expect(await claim(store, { fingerprint: hex('d'), token: 'token-2' })).toEqual({
          outcome: 'fingerprint-mismatch',
        });
      },
    );

    it('loses a complete from a token that does not hold the claim', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      expect(await store.complete(hex('a'), 'wrong', 'r', 60_000)).toBe('lost');
    });

    it('loses a release from a token that does not hold the claim', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      expect(await store.release(hex('a'), 'wrong')).toBe('lost');
    });

    it('settles a release and lets the next claim proceed', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      expect(await store.release(hex('a'), 'token-1')).toBe('settled');
      expect(await claim(store, { token: 'token-2' })).toEqual({
        outcome: 'claimed',
        takeover: false,
      });
    });

    it('restarts retention at ttlMs on complete', { ignore }, async () => {
      const store = await setup.make();
      await claim(store, { leaseMs: 100, ttlMs: 1_000 });
      await setup.advance(500);
      expect(await store.complete(hex('a'), 'token-1', 'r', 60_000)).toBe('settled');
      await setup.advance(1_000);
      expect(await claim(store, { fingerprint: hex('c') })).toEqual({
        outcome: 'completed',
        record: 'r',
      });
    });

    it('runs 50 concurrent claims of one key with exactly one claimed', { ignore }, async () => {
      const store = await setup.make();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_unused, index) => claim(store, { token: `token-${index}` })),
      );
      expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'in-progress')).toHaveLength(49);
    });

    it('round-trips a multi-byte UTF-8 record verbatim', { ignore }, async () => {
      const store = await setup.make();
      await claim(store);
      const record = 'héllo — 日本語 — 𝄞';
      expect(await store.complete(hex('a'), 'token-1', record, 60_000)).toBe('settled');
      expect(await claim(store, { token: 'token-2' })).toEqual({ outcome: 'completed', record });
    });

    if (label === 'memory') {
      it('refuses at the per-scope cap while another scope still claims', { ignore }, async () => {
        const store = await setup.make();
        await claim(store, { key: hex('1'), scope: hex('s') });
        // The default per-scope cap is 1,000, so a store built with cap 1 refuses
        // the second entry in one scope and accepts the other scope.
        expect(await claim(store, { key: hex('2'), scope: hex('s') })).toEqual({
          outcome: 'capacity-exceeded',
        });
        expect((await claim(store, { key: hex('3'), scope: hex('t') })).outcome).toBe('claimed');
      });

      it(
        'throws at the global cap rather than evicting a completed record',
        { ignore },
        async () => {
          // The memory `make` uses `maxEntries: 2`, so the third distinct entry
          // is the one that must be refused rather than evicted.
          const store = await setup.make();
          await claim(store, { key: hex('1'), scope: hex('s1') });
          await claim(store, { key: hex('2'), scope: hex('s2') });
          await expect(claim(store, { key: hex('3'), scope: hex('s3') })).rejects.toThrow(
            'memory idempotency store is full',
          );
        },
      );
    }
  });
}

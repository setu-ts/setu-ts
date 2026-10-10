import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey } from '@setu-ts/common';
import { countingObserver, edit, outboxHarness, row, WALL_START } from '../../fixtures/outbox.ts';
import { MAX_CLAIM_HORIZON_MS } from '../../../src/outbox/record-codec.ts';

const relay = { publishTimeoutMs: 10, storeTimeoutMs: 10, claimLeaseMs: 100, maxClockSkewMs: 5 };

describe('relay claims and fencing', () => {
  for (
    const change of [
      { claimVersion: 'secret-canary' },
      { claimVersion: -1 },
      { claimVersion: 1.5 },
      { claimVersion: Number.NaN },
      { claimVersion: Number.POSITIVE_INFINITY },
      { claimVersion: Number.MAX_SAFE_INTEGER },
      { claimVersion: Number.MAX_SAFE_INTEGER + 1 },
      { leaseUntil: -1 },
      { leaseUntil: 1.5 },
      { leaseUntil: 'secret-canary' },
      { leaseUntil: WALL_START + MAX_CLAIM_HORIZON_MS + 1 },
    ]
  ) {
    it(`poisons invalid claim fields ${JSON.stringify(change)} without claiming or publishing`, async () => {
      const h = await outboxHarness({ options: { relay } });
      const id = await h.write({ key: 'K', n: 1 });
      await h.write({ key: 'K', n: 2 });
      await edit(h.db, id, { ...change, attempts: 3 });
      expect((await h.sweep()).poisoned).toBe(1);
      expect(h.store.count('claim')).toBe(0);
      expect(h.store.count('markInvalid')).toBe(1);
      expect(h.broker.calls).toEqual([]);
      expect(await row(h.db, id)).toMatchObject({
        status: 'failed',
        lastError: 'invalid-row',
        attempts: 3,
        leaseUntil: 0,
      });
    });
  }

  it('claims MAX_SAFE_INTEGER - 1 and settles at the exact incremented version', async () => {
    const h = await outboxHarness({ options: { relay } });
    const id = await h.write({ n: 1 });
    await edit(h.db, id, { claimVersion: Number.MAX_SAFE_INTEGER - 1 });
    await h.sweep();
    expect(await row(h.db, id)).toMatchObject({
      status: 'sent',
      claimVersion: Number.MAX_SAFE_INTEGER,
    });
    expect(h.broker.sequence()).toEqual([1]);
  });

  it('skips before expiry plus skew, blocks the key, and takes over at equality', async () => {
    const h = await outboxHarness({ options: { relay } });
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await edit(h.db, id, { claimVersion: 1, leaseUntil: WALL_START + 100 });
    h.clock.setWall(WALL_START + 104);
    await h.sweep();
    expect(h.broker.calls).toEqual([]);
    expect(h.store.count('claim')).toBe(0);
    h.clock.advanceWall(1);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2]);
    expect((await row(h.db, id))!.claimVersion).toBe(2);
  });

  it('uses the global horizon for a live claim from a replica with a longer lease', async () => {
    const h = await outboxHarness({ options: { relay } });
    const id = await h.write({ n: 1 });
    await edit(h.db, id, { claimVersion: 1, leaseUntil: WALL_START + MAX_CLAIM_HORIZON_MS });
    await h.sweep();
    expect(h.store.count('markInvalid')).toBe(0);
    expect(h.store.count('claim')).toBe(0);
    expect((await row(h.db, id))!.status).toBe('pending');
  });

  for (const elapsed of [75, 76, 106]) {
    it(`checks the pre-publish fence after the claim resolves (${elapsed}ms elapsed)`, async () => {
      const observer = countingObserver();
      const h = await outboxHarness({ observer, options: { relay } });
      const id = await h.write({ key: 'K', n: 1 });
      h.store.claim = async (key, update) => {
        const result = await h.store.inner.claim(key, update);
        h.clock.advanceWall(elapsed);
        return result;
      };
      await h.sweep();
      if (elapsed === 75) {
        expect(h.broker.sequence()).toEqual([1]);
        expect(h.store.count('markSent')).toBe(1);
      } else {
        expect(h.broker.calls).toEqual([]);
        expect(h.store.count('markSent')).toBe(0);
        expect(h.store.count('markFailure')).toBe(0);
        expect(observer.counts['overlap-fenced']).toBe(1);
        expect(await row(h.db, id)).toMatchObject({ status: 'pending', claimVersion: 1 });
        h.store.claim = (key, update) => h.store.inner.claim(key, update);
        h.clock.setWall(WALL_START + 105);
        await h.sweep();
        expect(h.broker.sequence()).toEqual([1]);
      }
    });
  }

  for (const outcome of ['claim-lost', 'sent', 'discarded', 'failed', 'missing'] as const) {
    it(`a stale page at claim time classifies ${outcome} and blocks only unsent keys`, async () => {
      const observer = countingObserver();
      const h = await outboxHarness({
        observer,
        options: { relay: { ...relay, publishLimit: 1 } },
      });
      const id = await h.write({ key: 'K', n: 1 });
      await h.write({ key: 'K', n: 2 });
      h.store.faults.claim = async () => {
        delete h.store.faults.claim;
        if (outcome === 'missing') {
          await h.db.getRepository<Record<string, unknown>, EntityKey>('Outbox').delete(id);
        } else {await edit(
            h.db,
            id,
            outcome === 'claim-lost' ? { claimVersion: 1 } : { status: outcome },
          );}
      };
      await h.sweep();
      expect(h.broker.sequence()).toEqual(
        outcome === 'claim-lost' || outcome === 'failed' ? [] : [2],
      );
      expect(Object.keys(observer.counts).filter((key) => key.startsWith('overlap'))).toEqual([]);
    });
  }

  it('a publish failure releases its lease and retry waits only for backoff', async () => {
    const h = await outboxHarness({ options: { relay: { ...relay, baseBackoffMs: 10 } } });
    const id = await h.write({ n: 1 });
    h.broker.behaviour = () => Promise.reject(new Error('broker down'));
    await h.sweep();
    expect(await row(h.db, id)).toMatchObject({ claimVersion: 1, leaseUntil: 0, attempts: 1 });
    h.clock.advanceWall(10);
    h.broker.behaviour = undefined;
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1]);
    expect((await row(h.db, id))!.claimVersion).toBe(2);
  });
});

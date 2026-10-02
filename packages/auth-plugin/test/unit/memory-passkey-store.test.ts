import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import type { StoredPasskey } from '../../src/stores/passkey-store.ts';

/** Builds one stored credential. */
function credential(overrides: Partial<StoredPasskey> = {}): StoredPasskey {
  return {
    id: 'cred-1',
    principalId: 'alice',
    userHandle: 'handle-1',
    publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    algorithm: -7,
    counter: 0,
    backedUp: false,
    transports: ['internal'],
    attestation: 'unverified',
    createdAt: 1000,
    ...overrides,
  };
}

describe('MemoryPasskeyStore', () => {
  it('saves, reads, and lists by principal', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential(), { maxPerPrincipal: 100 });
    await store.save(credential({ id: 'cred-2' }), { maxPerPrincipal: 100 });
    expect(await store.findById('cred-1')).not.toBeNull();
    expect(await store.findById('missing')).toBeNull();
    const list = await store.listByPrincipal('alice');
    expect(list.length).toBe(2);
    expect(await store.listByPrincipal('bob')).toEqual([]);
  });

  it('deletes a credential', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential(), { maxPerPrincipal: 100 });
    await store.delete('cred-1');
    expect(await store.findById('cred-1')).toBeNull();
  });

  it('updateCounter advances and reports', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential(), { maxPerPrincipal: 100 });
    expect(await store.updateCounter('cred-1', 5)).toBe(true);
    const stored = await store.findById('cred-1');
    expect(stored?.counter).toBe(5);
  });

  it('updateCounter accepts a both-zero counter without changing anything', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential(), { maxPerPrincipal: 100 });
    expect(await store.updateCounter('cred-1', 0)).toBe(true);
    expect((await store.findById('cred-1'))?.counter).toBe(0);
  });

  it('updateCounter refuses a counter at or below the stored one', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential({ counter: 7 }), { maxPerPrincipal: 100 });
    expect(await store.updateCounter('cred-1', 7)).toBe(false);
    expect(await store.updateCounter('cred-1', 6)).toBe(false);
    expect((await store.findById('cred-1'))?.counter).toBe(7);
  });

  it('updateCounter refuses an unknown credential', async () => {
    const store = new MemoryPasskeyStore();
    expect(await store.updateCounter('missing', 5)).toBe(false);
  });

  it('concurrent updateCounter leaves exactly the higher counter stored', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential({ counter: 4 }), { maxPerPrincipal: 100 });
    // Two concurrent assertions carrying 5 and 7 against a stored 4.
    const outcomes = await Promise.all([
      store.updateCounter('cred-1', 5),
      store.updateCounter('cred-1', 7),
    ]);
    // The 7 wins; a later 6 is refused.
    expect(outcomes.every((outcome) => outcome === true)).toBe(true);
    expect((await store.findById('cred-1'))?.counter).toBe(7);
    expect(await store.updateCounter('cred-1', 6)).toBe(false);
  });

  it('hands back a copy of the saved credential, not the caller object', async () => {
    const store = new MemoryPasskeyStore();
    const record = credential();
    await store.save(record, { maxPerPrincipal: 100 });
    record.counter = 99;
    expect((await store.findById('cred-1'))?.counter).toBe(0);
  });

  it('hands back a deep copy: the array and JWK members are not shared', async () => {
    const store = new MemoryPasskeyStore();
    const record = credential();
    await store.save(record, { maxPerPrincipal: 100 });
    // Mutate the CALLER's nested members: the store's copy must be its own.
    (record.transports as string[]).push('usb');
    (record.publicKey as Record<string, unknown>).kty = 'RSA';
    const stored = await store.findById('cred-1');
    expect(stored?.transports).toEqual(['internal']);
    expect((stored?.publicKey as JsonWebKey).kty).toBe('EC');
  });

  it('save refuses an id that is already present, never overwriting', async () => {
    const store = new MemoryPasskeyStore();
    expect(await store.save(credential(), { maxPerPrincipal: 100 })).toBe('saved');
    // The same credential id from another principal: refused, and the first
    // principal's record survives.
    expect(
      await store.save(credential({ principalId: 'bob', createdAt: 2 }), { maxPerPrincipal: 100 }),
    ).toBe('duplicate');
    const stored = await store.findById('cred-1');
    expect(stored?.principalId).toBe('alice');
    expect(stored?.createdAt).toBe(1000);
  });

  it('concurrent saves of one id leave exactly the first stored', async () => {
    const store = new MemoryPasskeyStore();
    const outcomes = await Promise.all([
      store.save(credential({ principalId: 'alice' }), { maxPerPrincipal: 100 }),
      store.save(credential({ principalId: 'bob' }), { maxPerPrincipal: 100 }),
    ]);
    // Exactly one caller stored; the other was refused as a duplicate.
    expect(outcomes).toEqual(['saved', 'duplicate']);
  });

  it('enforces maxPerPrincipal in the same step as the insert, even under a burst', async () => {
    const store = new MemoryPasskeyStore();
    for (let i = 0; i < 15; i++) {
      expect(await store.save(credential({ id: `seed-${i}` }), { maxPerPrincipal: 16 })).toBe(
        'saved',
      );
    }
    // 40 concurrent saves at 15 held: exactly one fits.
    const outcomes = await Promise.all(
      Array.from(
        { length: 40 },
        (_, i) => store.save(credential({ id: `burst-${i}` }), { maxPerPrincipal: 16 }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'saved').length).toBe(1);
    expect(outcomes.filter((outcome) => outcome === 'limit').length).toBe(39);
    expect((await store.listByPrincipal('alice')).length).toBe(16);
    // The cap is per principal: another principal is unaffected, and a
    // duplicate id is reported as such even when the principal is full.
    expect(await store.save(credential({ id: 'b1', principalId: 'bob' }), { maxPerPrincipal: 16 }))
      .toBe('saved');
    expect(await store.save(credential({ id: 'seed-0' }), { maxPerPrincipal: 16 })).toBe(
      'duplicate',
    );
  });

  it('claimChallenge is single-use until its expiry', async () => {
    const store = new MemoryPasskeyStore();
    expect(await store.claimChallenge('challenge-1', 1000, 2000)).toBe(true);
    expect(await store.claimChallenge('challenge-1', 1500, 2000)).toBe(false);
    expect(await store.claimChallenge('challenge-1', 2000, 3000)).toBe(true);
  });

  it('claimChallenge purges expired claims so the map stays bounded', async () => {
    const store = new MemoryPasskeyStore();
    for (let i = 0; i < 100; i++) {
      await store.claimChallenge(`challenge-${i}`, 1000 + i, 2000 + i);
    }
    // One claim well past every expiry purges the lot.
    await store.claimChallenge('challenge-final', 100_000, 101_000);
    // An old challenge can be claimed again after the purge.
    expect(await store.claimChallenge('challenge-0', 100_000, 101_000)).toBe(true);
  });

  it('hands back detached copies, so mutating a returned record cannot change the store', async () => {
    const store = new MemoryPasskeyStore();
    await store.save({
      id: 'c1',
      principalId: 'alice',
      userHandle: 'h',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      algorithm: -7,
      counter: 4,
      backedUp: false,
      transports: ['internal'],
      attestation: 'unverified',
      createdAt: 0,
    }, { maxPerPrincipal: 100 });
    const read = await store.findById('c1');
    if (read === null) throw new Error('expected the stored credential');
    read.counter = 99;
    read.publicKey.x = 'tampered';
    const [listed] = await store.listByPrincipal('alice');
    if (listed === undefined) throw new Error('expected the listed credential');
    listed.counter = 77;
    const again = await store.findById('c1');
    expect(again?.counter).toBe(4);
    expect(again?.publicKey.x).toBe('x');
    expect(again?.transports).toEqual(['internal']);
    expect(again?.transports).not.toBe(read.transports);
  });

  it('claimChallenge stays linear in the live claims — no full scan per claim', async () => {
    // Claims are reachable from unauthenticated requests, so a per-claim scan of
    // every live claim is quadratic: 40 000 live claims took ~2.6 s that way,
    // and 60 000 takes several seconds. Amortized, it is tens of milliseconds;
    // the bound leaves a wide margin for a slow runner.
    const store = new MemoryPasskeyStore();
    const start = performance.now();
    for (let i = 0; i < 60_000; i++) {
      await store.claimChallenge(`live-${i}`, 1000, 1_000_000);
    }
    expect(performance.now() - start).toBeLessThan(1500);
    // Every one of them is still a live claim.
    expect(await store.claimChallenge('live-0', 1000, 1_000_000)).toBe(false);
    expect(await store.claimChallenge('live-59999', 1000, 1_000_000)).toBe(false);
  });

  it('claimChallenge treats an unswept lapsed claim as free and sweeps once the map doubles', async () => {
    const store = new MemoryPasskeyStore();
    for (let i = 0; i < 200; i++) {
      await store.claimChallenge(`old-${i}`, 1000, 2000);
    }
    // Lapsed, whether or not a sweep has removed the row yet.
    expect(await store.claimChallenge('old-199', 5000, 6000)).toBe(true);
    expect(await store.claimChallenge('old-0', 5000, 6000)).toBe(true);
  });
});

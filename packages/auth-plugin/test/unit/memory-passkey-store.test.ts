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
    await store.save(credential());
    await store.save(credential({ id: 'cred-2' }));
    expect(await store.findById('cred-1')).not.toBeNull();
    expect(await store.findById('missing')).toBeNull();
    const list = await store.listByPrincipal('alice');
    expect(list.length).toBe(2);
    expect(await store.listByPrincipal('bob')).toEqual([]);
  });

  it('deletes a credential', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential());
    await store.delete('cred-1');
    expect(await store.findById('cred-1')).toBeNull();
  });

  it('updateCounter advances and reports', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential());
    expect(await store.updateCounter('cred-1', 5)).toBe(true);
    const stored = await store.findById('cred-1');
    expect(stored?.counter).toBe(5);
  });

  it('updateCounter accepts a both-zero counter without changing anything', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential());
    expect(await store.updateCounter('cred-1', 0)).toBe(true);
    expect((await store.findById('cred-1'))?.counter).toBe(0);
  });

  it('updateCounter refuses a counter at or below the stored one', async () => {
    const store = new MemoryPasskeyStore();
    await store.save(credential({ counter: 7 }));
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
    await store.save(credential({ counter: 4 }));
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
    await store.save(record);
    record.counter = 99;
    expect((await store.findById('cred-1'))?.counter).toBe(0);
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
});

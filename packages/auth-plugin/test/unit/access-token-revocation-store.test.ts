/** Tests for the in-memory access-token revocation store. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAccessTokenRevocationStore } from '../../src/stores/access-token-revocation-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryAccessTokenRevocationStore', () => {
  it('marks an access token revoked until its expiry', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryAccessTokenRevocationStore(runtime);

    await store.revoke('access-1', runtime.now() + 1000);

    expect(await store.isRevoked('access-1')).toBe(true);
    expect(await store.isRevoked('other')).toBe(false);
  });

  it('lazily removes an entry once the credential has expired', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryAccessTokenRevocationStore(runtime);
    const expiresAt = runtime.now() + 1000;

    await store.revoke('access-1', expiresAt);
    runtime.setNow(expiresAt);

    expect(await store.isRevoked('access-1')).toBe(false);
    expect(await store.isRevoked('access-1')).toBe(false);
  });

  it('does not retain an identifier already expired at revoke time', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryAccessTokenRevocationStore(runtime);

    await store.revoke('access-1', runtime.now());

    expect(await store.isRevoked('access-1')).toBe(false);
  });

  it('globally sweeps expired entries on a later unrelated access', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryAccessTokenRevocationStore(runtime);
    const expiresAt = runtime.now() + 1000;
    await store.revoke('access-1', expiresAt);
    runtime.setNow(expiresAt);

    expect(await store.isRevoked('other')).toBe(false);
    runtime.setNow(expiresAt - 1);
    expect(await store.isRevoked('access-1')).toBe(false);
  });

  it('cleans expiry entries in order without scanning active revocations', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryAccessTokenRevocationStore(runtime);
    await store.revoke('one-hundred', 100);
    await store.revoke('three-hundred', 300);
    await store.revoke('two-hundred', 200);
    await store.revoke('four-hundred', 400);
    await store.revoke('three-fifty', 350);
    await store.revoke('fifty', 50);

    runtime.setNow(50);

    expect(await store.isRevoked('fifty')).toBe(false);
    expect(await store.isRevoked('one-hundred')).toBe(true);
    expect(await store.isRevoked('two-hundred')).toBe(true);
    expect(await store.isRevoked('three-hundred')).toBe(true);
    expect(await store.isRevoked('three-fifty')).toBe(true);
    expect(await store.isRevoked('four-hundred')).toBe(true);
  });

  it('retains the latest expiry when an older heap entry is swept', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryAccessTokenRevocationStore(runtime);
    await store.revoke('access-1', 100);
    await store.revoke('access-1', 200);

    runtime.setNow(100);
    expect(await store.isRevoked('other')).toBe(false);
    expect(await store.isRevoked('access-1')).toBe(true);

    runtime.setNow(200);
    expect(await store.isRevoked('access-1')).toBe(false);
  });

  it('rejects a non-finite expiry instead of retaining an entry forever', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryAccessTokenRevocationStore(runtime);

    await expect(store.revoke('access-1', Infinity)).rejects.toThrow('must be finite');
    await expect(store.revoke('access-2', NaN)).rejects.toThrow('must be finite');
  });
});

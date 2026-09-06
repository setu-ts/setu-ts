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
});

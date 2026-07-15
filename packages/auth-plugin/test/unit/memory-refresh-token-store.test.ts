/**
 * Unit tests for MemoryRefreshTokenStore.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryRefreshTokenStore } from '../../src/stores/refresh-token-store.ts';
import type { RefreshTokenRecord } from '../../src/stores/refresh-token-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function makeRecord(
  runtime: ReturnType<typeof createFakeRuntime>,
  jti = 'token-123',
): RefreshTokenRecord {
  return {
    jti,
    principalId: 'user-1',
    principal: { id: 'user-1', roles: ['user'] },
    expiresAt: runtime.now() + 7 * 24 * 60 * 60 * 1000,
    revoked: false,
  };
}

describe('MemoryRefreshTokenStore', () => {
  it('save then get returns the record', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const record = makeRecord(runtime);

    await store.save(record);
    const found = await store.get('token-123');

    expect(found).toEqual(record);
  });

  it('get after revoke returns the record flagged revoked (caller distinguishes replay)', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);

    await store.save(makeRecord(runtime));
    await store.revoke('token-123');
    const found = await store.get('token-123');

    expect(found).not.toBeNull();
    expect(found?.revoked).toBe(true);
  });

  it('revoke of a missing jti is a no-op', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);

    await store.revoke('nonexistent');
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('expired record is evicted on get and returns null', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const record = makeRecord(runtime);

    await store.save(record);

    // Advance time to exactly the expiry instant (now >= expiresAt evicts)
    runtime.setNow(record.expiresAt);

    const found = await store.get('token-123');
    expect(found).toBeNull();

    // A second get also returns null (the entry was deleted, not just hidden)
    expect(await store.get('token-123')).toBeNull();
  });

  it('missing jti returns null', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);

    expect(await store.get('nonexistent')).toBeNull();
  });
});

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

  it('rotates one live record atomically and refuses a second consume', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    await store.save({ ...makeRecord(runtime, 'parent'), familyId: 'family-1' });
    const successor = { ...makeRecord(runtime, 'child'), familyId: 'family-1' };

    const [first, second] = await Promise.all([
      store.rotate('parent', successor),
      store.rotate('parent', { ...makeRecord(runtime, 'other-child'), familyId: 'family-1' }),
    ]);

    expect([first, second].filter((result) => result.rotated)).toHaveLength(1);
    expect((await store.get('parent'))?.revoked).toBe(true);
    expect(await store.get('child')).not.toBeNull();
    expect(await store.get('other-child')).toBeNull();
  });

  it('does not rotate an expired or already-revoked record', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const expired = { ...makeRecord(runtime, 'expired'), expiresAt: runtime.now() };
    await store.save(expired);

    const expiredResult = await store.rotate('expired', makeRecord(runtime, 'child'));
    expect(expiredResult).toEqual({ record: null, rotated: false });

    await store.save(makeRecord(runtime, 'revoked'));
    await store.revoke('revoked');
    const revokedResult = await store.rotate('revoked', makeRecord(runtime, 'child-2'));
    expect(revokedResult.record?.revoked).toBe(true);
    expect(revokedResult.rotated).toBe(false);
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

  it('revokeFamily revokes every live record in the requested lineage', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const first = { ...makeRecord(runtime, 'first'), familyId: 'family-1' };
    const second = { ...makeRecord(runtime, 'second'), familyId: 'family-1' };
    const other = { ...makeRecord(runtime, 'other'), familyId: 'family-2' };

    await store.save(first);
    await store.save(second);
    await store.save(other);

    const revoked = await store.revokeFamily('first');

    expect(revoked.map((record) => record.jti).sort()).toEqual(['first', 'second']);
    expect((await store.get('first'))?.revoked).toBe(true);
    expect((await store.get('second'))?.revoked).toBe(true);
    expect((await store.get('other'))?.revoked).toBe(false);
  });

  it('refuses rotation after the parent family has been revoked', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    await store.save({ ...makeRecord(runtime, 'parent'), familyId: 'family-1' });

    await store.revokeFamily('parent');
    const result = await store.rotate(
      'parent',
      { ...makeRecord(runtime, 'child'), familyId: 'family-1' },
    );

    expect(result.rotated).toBe(false);
    expect(await store.get('child')).toBeNull();
  });

  it('treats a legacy record without familyId as its own family', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    await store.save(makeRecord(runtime, 'legacy'));

    const revoked = await store.revokeFamily('legacy');

    expect(revoked.map((record) => record.jti)).toEqual(['legacy']);
    expect((await store.get('legacy'))?.revoked).toBe(true);
  });

  it('returns no records when the requested family token is missing', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);

    expect(await store.revokeFamily('missing')).toEqual([]);
  });

  it('evicts an expired requested family token rather than revoking it', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const record = makeRecord(runtime, 'expired');
    await store.save(record);
    runtime.setNow(record.expiresAt);

    expect(await store.revokeFamily('expired')).toEqual([]);
    expect(await store.get('expired')).toBeNull();
  });

  it('returns and evicts an expired sibling while revoking a live family member', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRefreshTokenStore(runtime);
    const live = { ...makeRecord(runtime, 'live'), familyId: 'family-1' };
    const expired = {
      ...makeRecord(runtime, 'expired'),
      familyId: 'family-1',
      expiresAt: runtime.now(),
    };
    await store.save(live);
    await store.save(expired);

    const revoked = await store.revokeFamily('live');

    expect(revoked.map((record) => record.jti).sort()).toEqual(['expired', 'live']);
    expect(expired.revoked).toBe(true);
    expect(await store.get('expired')).toBeNull();
  });
});

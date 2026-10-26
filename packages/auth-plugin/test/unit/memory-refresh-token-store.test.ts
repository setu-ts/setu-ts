/**
 * Unit tests for MemoryRefreshTokenStore.
 */

import { describe, expect, it, vi } from 'vitest';
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
  it('D4 sweeps 100,000 unread expired records while retaining live tokens and revoked reuse evidence', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryRefreshTokenStore(runtime);
    const live = makeRecord(runtime, 'live-token');
    const revoked = { ...makeRecord(runtime, 'revoked-token'), revoked: true };
    const writes = vi.spyOn(Map.prototype, 'set');
    let entries: Map<unknown, unknown> | undefined;
    try {
      await store.save(live);
      entries = writes.mock.contexts.find(
        (map): map is Map<unknown, unknown> => map instanceof Map && map.has(live.jti),
      );
    } finally {
      writes.mockRestore();
    }
    expect(entries).toBeDefined();
    await store.save(revoked);
    for (let i = 0; i < 100_000; i++) {
      await store.save({ ...makeRecord(runtime, `expired-${i}`), expiresAt: 1 });
    }
    runtime.setNow(1);
    // The previous sweep had 65,536 survivors. Fill to its doubled threshold,
    // then make the one save that must reclaim every unread expired record.
    for (let i = 100_000; i < 131_070; i++) {
      await store.save({ ...makeRecord(runtime, `expired-${i}`), expiresAt: 1 });
    }
    await store.save(makeRecord(runtime, 'fresh-token'));
    expect(await store.get(live.jti)).toEqual(live);
    expect(await store.get(revoked.jti)).toEqual(revoked);
    expect(await store.rotate(revoked.jti, makeRecord(runtime, 'refused-child'))).toEqual({
      record: revoked,
      rotated: false,
    });
    expect(await store.get('refused-child')).toBeNull();
    expect(entries!.size).toBeLessThan(2_048);
  });

  it('sweeps expired records on the rotation write path, not only on save', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryRefreshTokenStore(runtime);
    const first = { ...makeRecord(runtime, 'chain-0'), expiresAt: 10 };
    const writes = vi.spyOn(Map.prototype, 'set');
    let entries: Map<unknown, unknown> | undefined;
    try {
      await store.save(first);
      entries = writes.mock.contexts.find(
        (map): map is Map<unknown, unknown> => map instanceof Map && map.has(first.jti),
      );
    } finally {
      writes.mockRestore();
    }
    expect(entries).toBeDefined();
    // One login, then only rotations: each successor lives 10 ms and every
    // rotated-out predecessor expires behind the chain.
    for (let i = 1; i <= 5_000; i++) {
      runtime.setNow(i);
      const successor = { ...makeRecord(runtime, `chain-${i}`), expiresAt: i + 10 };
      expect((await store.rotate(`chain-${i - 1}`, successor)).rotated).toBe(true);
    }
    expect(await store.get('chain-5000')).toMatchObject({ jti: 'chain-5000', revoked: false });
    expect(entries!.size).toBeLessThan(2_048);
  });

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
    const result = await store.rotate('parent', {
      ...makeRecord(runtime, 'child'),
      familyId: 'family-1',
    });

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

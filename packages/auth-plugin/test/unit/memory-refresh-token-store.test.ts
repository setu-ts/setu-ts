/**
 * Unit tests for MemoryRefreshTokenStore.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MemoryRefreshTokenStore } from '../../src/stores/refresh-token-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

Deno.test('MemoryRefreshTokenStore — save then get returns the record', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRefreshTokenStore(runtime);

  const record = {
    jti: 'token-123',
    principalId: 'user-1',
    principal: { id: 'user-1', roles: ['user'] },
    expiresAt: runtime.now() + 7 * 24 * 60 * 60 * 1000,
    revoked: false,
  };

  await store.save(record);
  const found = await store.get('token-123');
  assertEquals(found, record);
});

Deno.test('MemoryRefreshTokenStore — get after revoke returns null', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRefreshTokenStore(runtime);

  const record = {
    jti: 'token-123',
    principalId: 'user-1',
    principal: { id: 'user-1' },
    expiresAt: runtime.now() + 7 * 24 * 60 * 60 * 1000,
    revoked: false,
  };

  await store.save(record);
  await store.revoke('token-123');
  const found = await store.get('token-123');
  assertEquals(found, null);
});

Deno.test('MemoryRefreshTokenStore — expired record is evicted on get', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRefreshTokenStore(runtime);

  const record = {
    jti: 'token-123',
    principalId: 'user-1',
    principal: { id: 'user-1' },
    expiresAt: runtime.now() + 7 * 24 * 60 * 60 * 1000,
    revoked: false,
  };

  await store.save(record);

  // Advance time past expiry
  runtime.setNow(record.expiresAt + 1);

  const found = await store.get('token-123');
  assertEquals(found, null);
});

Deno.test('MemoryRefreshTokenStore — missing jti returns null', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRefreshTokenStore(runtime);

  const found = await store.get('nonexistent');
  assertEquals(found, null);
});

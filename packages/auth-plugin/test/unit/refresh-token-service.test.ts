/**
 * Unit tests for RefreshTokenService.
 *
 * Covers: issue, refresh (rotation), replay rejection, revocation.
 */

import { assert, assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { RefreshTokenService } from '../../src/services/refresh-token-service.ts';
import type { TokenPair } from '../../src/services/refresh-token-service.ts';
import { MemoryRefreshTokenStore } from '../../src/stores/refresh-token-store.ts';
import { JwtService } from '../../src/services/jwt-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

Deno.test('RefreshTokenService — issue returns a valid token pair', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, {
    algorithm: 'HS256',
    secret: 'test-secret',
  });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = {
    id: 'user-123',
    roles: ['user'],
    permissions: ['users:read'],
  };

  const pair = await service.issue(principal);

  // Verify access token
  const accessPayload = await jwt.verify<{
    sub: string;
    roles: string[];
    permissions: string[];
  }>(pair.accessToken);
  assertEquals(accessPayload.sub, 'user-123');
  assertEquals(accessPayload.roles, ['user']);
  assertEquals(accessPayload.permissions, ['users:read']);

  // Verify refresh token has type:'refresh' and jti
  const refreshPayload = await jwt.verify<{
    sub: string;
    type: 'refresh';
    jti: string;
  }>(pair.refreshToken);
  assertEquals(refreshPayload.type, 'refresh');
  assertEquals(refreshPayload.sub, 'user-123');
  assertEquals(typeof refreshPayload.jti, 'string');

  // Verify store has the record
  const record = await store.get(refreshPayload.jti);
  assertEquals(record?.principalId, 'user-123');
  assertEquals(record?.revoked, false);
});

Deno.test('RefreshTokenService — refresh rotates and issues a new pair', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = { id: 'user-123', roles: ['user'] };
  const pair1 = await service.issue(principal);

  // First refresh — should succeed and rotate
  const pair2 = await service.refresh(pair1.refreshToken);
  assertExists(pair2);
  assertEquals(pair2.accessToken, pair1.accessToken); // Same access claims
  assert(pair2.refreshToken !== pair1.refreshToken); // NEW refresh token with new jti

  // Verify the new token has a different jti
  const oldJti = (await jwt.verify<{ jti: string }>(pair1.refreshToken)).jti;
  const newJti = (await jwt.verify<{ jti: string }>(pair2.refreshToken)).jti;
  assert(oldJti !== newJti);
});

Deno.test('RefreshTokenService — replay rejection', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = { id: 'user-123', roles: ['user'] };
  const pair = await service.issue(principal);

  // First refresh succeeds and rotates
  await service.refresh(pair.refreshToken);

  // Second refresh with the SAME original token — jti is revoked, should return null
  const pair3 = await service.refresh(pair.refreshToken);
  assertEquals(pair3, null);
});

Deno.test('RefreshTokenService — revoke works', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = { id: 'user-123' };
  const pair = await service.issue(principal);

  const revoked = await service.revoke(pair.refreshToken);
  assertEquals(revoked, true);

  // Refresh after revoke returns null
  const pair2 = await service.refresh(pair.refreshToken);
  assertEquals(pair2, null);
});

Deno.test('RefreshTokenService — expired token returns null', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = { id: 'user-123' };
  const pair = await service.issue(principal);
  const refreshPayload = await jwt.verify<{ jti: string }>(pair.refreshToken);

  // Advance time past expiry
  runtime.setNow(runtime.now() + 8 * 24 * 60 * 60 * 1000); // 8 days later

  // Store.get will lazy-expire and return null
  const record = await store.get(refreshPayload.jti);
  assertEquals(record, null);

  // Refresh throws on expired token
  let refreshed: TokenPair | null = null;
  try {
    refreshed = await service.refresh(pair.refreshToken);
  } catch {
    refreshed = null;
  }
  assertEquals(refreshed, null);
});

Deno.test('RefreshTokenService — tampered token returns null', async () => {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({ jwt, store, runtime });

  const principal = { id: 'user-123' };
  const pair = await service.issue(principal);

  // Tamper with the payload (not the signature)
  const parts = pair.refreshToken.split('.');
  const tamperedPayload = globalThis.btoa(
    JSON.stringify({ sub: 'user-123', type: 'refresh', jti: 'hacked' }),
  );
  const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

  let refreshed: TokenPair | null = null;
  try {
    refreshed = await service.refresh(tampered);
  } catch {
    refreshed = null;
  }
  assertEquals(refreshed, null); // Signature mismatch
});

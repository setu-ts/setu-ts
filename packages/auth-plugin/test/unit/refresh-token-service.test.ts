/**
 * Unit tests for RefreshTokenService.
 *
 * Covers: issue, refresh (rotation), replay rejection, revocation, option
 * handling (accessToken vs refreshTokenExpiresIn lifetimes), and the
 * invalid/expired/tampered-token null paths.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RefreshTokenService } from '../../src/services/refresh-token-service.ts';
import { MemoryRefreshTokenStore } from '../../src/stores/refresh-token-store.ts';
import { JwtService } from '../../src/services/jwt-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function makeService(options?: {
  accessToken?: { expiresIn?: string; audience?: string; issuer?: string };
  refreshTokenExpiresIn?: string;
}): {
  runtime: ReturnType<typeof createFakeRuntime>;
  jwt: JwtService;
  store: MemoryRefreshTokenStore;
  service: RefreshTokenService;
} {
  const runtime = createFakeRuntime();
  const jwt = new JwtService(runtime, { algorithm: 'HS256', secret: 'test-secret' });
  const store = new MemoryRefreshTokenStore(runtime);
  const service = new RefreshTokenService({
    jwt,
    store,
    runtime,
    ...(options?.accessToken !== undefined ? { accessToken: options.accessToken } : {}),
    ...(options?.refreshTokenExpiresIn !== undefined
      ? { refreshTokenExpiresIn: options.refreshTokenExpiresIn }
      : {}),
  });
  return { runtime, jwt, store, service };
}

describe('RefreshTokenService', () => {
  describe('issue', () => {
    it('returns a valid token pair with round-tripping access claims', async () => {
      const { jwt, store, service } = makeService();
      const principal = {
        id: 'user-123',
        roles: ['user'],
        permissions: ['users:read'],
      };

      const pair = await service.issue(principal);

      const accessPayload = await jwt.verify<{
        sub: string;
        roles: string[];
        permissions: string[];
      }>(pair.accessToken);
      expect(accessPayload.sub).toBe('user-123');
      expect(accessPayload.roles).toEqual(['user']);
      expect(accessPayload.permissions).toEqual(['users:read']);

      const refreshPayload = await jwt.verify<{
        sub: string;
        type: string;
        jti: string;
      }>(pair.refreshToken);
      expect(refreshPayload.type).toBe('refresh');
      expect(refreshPayload.sub).toBe('user-123');
      expect(typeof refreshPayload.jti).toBe('string');

      const record = await store.get(refreshPayload.jti);
      expect(record?.principalId).toBe('user-123');
      expect(record?.revoked).toBe(false);
    });

    it('signs the refresh token with refreshTokenExpiresIn, NOT the access lifetime', async () => {
      const { jwt, service } = makeService({
        accessToken: { expiresIn: '30m' },
        refreshTokenExpiresIn: '1h',
      });

      const pair = await service.issue({ id: 'user-123' });

      const accessPayload = await jwt.verify<{ iat: number; exp: number }>(pair.accessToken);
      expect(accessPayload.exp - accessPayload.iat).toBe(1800); // 30m

      const refreshPayload = await jwt.verify<{ iat: number; exp: number }>(pair.refreshToken);
      expect(refreshPayload.exp - refreshPayload.iat).toBe(3600); // 1h — the REFRESH lifetime
    });

    it('defaults the refresh token JWT lifetime to 7d', async () => {
      const { jwt, service } = makeService();

      const pair = await service.issue({ id: 'user-123' });

      const refreshPayload = await jwt.verify<{ iat: number; exp: number }>(pair.refreshToken);
      expect(refreshPayload.exp - refreshPayload.iat).toBe(7 * 24 * 60 * 60);
    });

    it('carries configured audience/issuer on both tokens so verify enforces them', async () => {
      const { jwt, service } = makeService({
        accessToken: { expiresIn: '15m', audience: 'my-app', issuer: 'auth-svc' },
      });

      const pair = await service.issue({ id: 'user-123', roles: ['user'] });

      const accessPayload = await jwt.verify<{ aud: string; iss: string }>(pair.accessToken);
      expect(accessPayload.aud).toBe('my-app');
      expect(accessPayload.iss).toBe('auth-svc');

      const refreshPayload = await jwt.verify<{ type: string; aud: string; iss: string }>(
        pair.refreshToken,
      );
      expect(refreshPayload.type).toBe('refresh');
      expect(refreshPayload.aud).toBe('my-app');
      expect(refreshPayload.iss).toBe('auth-svc');
    });

    it('refreshTokenExpiresIn controls the store record expiry', async () => {
      const { runtime, jwt, store, service } = makeService({ refreshTokenExpiresIn: '1h' });

      const pair = await service.issue({ id: 'user-123' });
      const refreshPayload = await jwt.verify<{ jti: string }>(pair.refreshToken);

      expect((await store.get(refreshPayload.jti))?.principalId).toBe('user-123');

      // Advance past 1h — record is lazily evicted
      runtime.setNow(runtime.now() + 3600001);
      expect(await store.get(refreshPayload.jti)).toBeNull();
    });

    it('defaults the store record expiry to 7d', async () => {
      const { runtime, jwt, store, service } = makeService();

      const pair = await service.issue({ id: 'user-123' });
      const refreshPayload = await jwt.verify<{ jti: string }>(pair.refreshToken);

      expect((await store.get(refreshPayload.jti))?.principalId).toBe('user-123');

      runtime.setNow(runtime.now() + 7 * 24 * 60 * 60 * 1000 + 1);
      expect(await store.get(refreshPayload.jti)).toBeNull();
    });
  });

  describe('refresh (rotation)', () => {
    it('returns a NEW pair and rotates the jti', async () => {
      const { jwt, service } = makeService();
      const pair1 = await service.issue({ id: 'user-123', roles: ['user'] });

      const pair2 = await service.refresh(pair1.refreshToken);

      expect(pair2).not.toBeNull();
      expect(pair2?.refreshToken).not.toBe(pair1.refreshToken);

      const oldJti = (await jwt.verify<{ jti: string }>(pair1.refreshToken)).jti;
      const newJti = (await jwt.verify<{ jti: string }>(pair2!.refreshToken)).jti;
      expect(oldJti).not.toBe(newJti);

      // The re-minted access token carries the snapshot principal's claims
      const accessPayload = await jwt.verify<{ sub: string; roles: string[] }>(
        pair2!.accessToken,
      );
      expect(accessPayload.sub).toBe('user-123');
      expect(accessPayload.roles).toEqual(['user']);
    });

    it('rejects replay: refreshing the same token twice returns null the second time', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      const first = await service.refresh(pair.refreshToken);
      expect(first).not.toBeNull();

      const second = await service.refresh(pair.refreshToken);
      expect(second).toBeNull();
    });

    it('returns null for an expired refresh token (verify rejects, no throw)', async () => {
      const { runtime, service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      // Advance past the 7d default expiry
      runtime.setNow(runtime.now() + 8 * 24 * 60 * 60 * 1000);

      expect(await service.refresh(pair.refreshToken)).toBeNull();
    });

    it('returns null for a tampered refresh token (signature mismatch, no throw)', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      const parts = pair.refreshToken.split('.');
      const tamperedPayload = globalThis.btoa(
        JSON.stringify({ sub: 'user-123', type: 'refresh', jti: 'hacked' }),
      );
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(await service.refresh(tampered)).toBeNull();
    });

    it('returns null for a garbage token string', async () => {
      const { service } = makeService();
      expect(await service.refresh('not.a.token')).toBeNull();
    });

    it('returns null for a valid JWT that is not a refresh token (no type claim)', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      // The ACCESS token verifies fine but has no type:'refresh'
      expect(await service.refresh(pair.accessToken)).toBeNull();
    });

    it('returns null for a refresh-typed JWT without a jti claim', async () => {
      const { jwt, service } = makeService();
      const forged = await jwt.sign({ sub: 'user-123', type: 'refresh' }, { expiresIn: '1h' });

      expect(await service.refresh(forged)).toBeNull();
    });

    it('returns null after revoke (revoked record rejected)', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      expect(await service.revoke(pair.refreshToken)).toBe(true);
      expect(await service.refresh(pair.refreshToken)).toBeNull();
    });

    it('sequential double refresh of one token: first wins, second yields null', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      const [first, second] = [
        await service.refresh(pair.refreshToken),
        await service.refresh(pair.refreshToken),
      ];
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('revoke', () => {
    it('returns true when a live record is revoked', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      expect(await service.revoke(pair.refreshToken)).toBe(true);
    });

    it('returns false when the record is already revoked', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      expect(await service.revoke(pair.refreshToken)).toBe(true);
      expect(await service.revoke(pair.refreshToken)).toBe(false);
    });

    it('returns false for a token that does not verify (tampered)', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      const parts = pair.refreshToken.split('.');
      const tamperedPayload = globalThis.btoa(
        JSON.stringify({ sub: 'user-123', type: 'refresh', jti: 'hacked' }),
      );
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(await service.revoke(tampered)).toBe(false);
    });

    it('returns false for a completely unparseable token', async () => {
      const { service } = makeService();
      expect(await service.revoke('not.a.token')).toBe(false);
    });

    it('returns false for a valid JWT without a jti claim', async () => {
      const { service } = makeService();
      const pair = await service.issue({ id: 'user-123' });

      // The access token verifies but carries no jti
      expect(await service.revoke(pair.accessToken)).toBe(false);
    });

    it('returns false for a validly-signed refresh token whose jti is unknown to the store', async () => {
      const { jwt, service } = makeService();

      const forged = await jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'never-issued' },
        { expiresIn: '1h' },
      );

      expect(await service.revoke(forged)).toBe(false);
    });
  });
});

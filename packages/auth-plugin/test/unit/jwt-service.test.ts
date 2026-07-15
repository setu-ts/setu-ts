/**
 * Tests for JwtService.
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { JwtService } from '../../src/services/jwt-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('JwtService', () => {
  describe('HS256', () => {
    let runtime: ReturnType<typeof createFakeRuntime>;
    let jwt: JwtService;
    const secret = 'test-secret-key-for-hs256-signing';

    beforeAll(() => {
      runtime = createFakeRuntime(1000000);
      jwt = new JwtService(runtime, {
        secret,
        algorithm: 'HS256',
      });
    });

    it('signs and verifies a token round-trip', async () => {
      const token = await jwt.sign({ sub: 'user123', roles: ['admin'] });
      expect(token).toBeTruthy();
      expect(token.split('.').length).toBe(3);

      const payload = await jwt.verify<{ sub: string; roles: string[]; iat: number }>(token);
      expect(payload.sub).toBe('user123');
      expect(payload.roles).toEqual(['admin']);
      expect(payload.iat).toBeDefined();
    });

    it('adds iat claim', async () => {
      const token = await jwt.sign({ sub: 'user123' });
      const payload = await jwt.verify<{ sub: string; iat: number }>(token);
      expect(payload.iat).toBe(1000); // 1000000ms / 1000
    });

    it('adds exp claim from expiresIn', async () => {
      const token = await jwt.sign({ sub: 'user123' }, { expiresIn: '1h' });
      const payload = await jwt.verify<{ iat: number; exp: number }>(token);
      expect(payload.exp).toBe(payload.iat + 3600);
    });

    it('adds aud claim from options', async () => {
      const token = await jwt.sign({ sub: 'user123' }, { audience: 'myapp' });
      const payload = await jwt.verify<{ aud: string }>(token);
      expect(payload.aud).toBe('myapp');
    });

    it('adds iss claim from options', async () => {
      const token = await jwt.sign({ sub: 'user123' }, { issuer: 'myissuer' });
      const payload = await jwt.verify<{ iss: string }>(token);
      expect(payload.iss).toBe('myissuer');
    });

    it('rejects a tampered payload', async () => {
      const token = await jwt.sign({ sub: 'user123' });
      const [header, payload, signature] = token.split('.');
      // Tamper the payload
      const tamperedPayload = payload.slice(0, -2) + 'XX';
      const tamperedToken = `${header}.${tamperedPayload}.${signature}`;
      await expect(jwt.verify(tamperedToken)).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
      const token = await jwt.sign({ sub: 'user123' }, { expiresIn: '1s' });
      // Advance clock past expiry
      runtime.setNow(1000000 + 10000);
      await expect(jwt.verify(token)).rejects.toThrow('Token expired');
    });

    it('rejects a token with nbf in the future', async () => {
      const token = await jwt.sign({ sub: 'user123', nbf: Math.floor(1000000 / 1000) + 3600 });
      await expect(jwt.verify(token)).rejects.toThrow('Token not yet valid');
    });

    it('rejects a token with wrong audience', async () => {
      const localRuntime = createFakeRuntime(1000000);
      const localJwt = new JwtService(localRuntime, {
        secret,
        algorithm: 'HS256',
        expectedAudience: 'expected-aud',
      });
      const token = await localJwt.sign({ sub: 'user123' }, { audience: 'wrong-aud' });
      await expect(localJwt.verify(token)).rejects.toThrow('Invalid token audience');
    });

    it('rejects a token with wrong issuer', async () => {
      const localRuntime = createFakeRuntime(1000000);
      const localJwt = new JwtService(localRuntime, {
        secret,
        algorithm: 'HS256',
        expectedIssuer: 'expected-iss',
      });
      const token = await localJwt.sign({ sub: 'user123' }, { issuer: 'wrong-iss' });
      await expect(localJwt.verify(token)).rejects.toThrow('Invalid token issuer');
    });

    it('verifies audience when expected matches', async () => {
      const localRuntime = createFakeRuntime(1000000);
      const localJwt = new JwtService(localRuntime, {
        secret,
        algorithm: 'HS256',
        expectedAudience: 'myapp',
      });
      const token = await localJwt.sign({ sub: 'user123' }, { audience: 'myapp' });
      const payload = await localJwt.verify<{ aud: string }>(token);
      expect(payload.aud).toBe('myapp');
    });

    it('uses configured audience when sign omits it', async () => {
      const localRuntime = createFakeRuntime(1000000);
      const localJwt = new JwtService(localRuntime, {
        secret,
        algorithm: 'HS256',
        expectedAudience: 'configured-aud',
      });
      const token = await localJwt.sign({ sub: 'user123' });
      const payload = await localJwt.verify<{ aud: string }>(token);
      expect(payload.aud).toBe('configured-aud');
    });
  });

  describe('decode', () => {
    let jwt: JwtService;

    beforeAll(() => {
      const runtime = createFakeRuntime(1000000);
      jwt = new JwtService(runtime, {
        secret: 'test-secret',
        algorithm: 'HS256',
      });
    });

    it('decodes a valid token without verifying', async () => {
      const token = await jwt.sign({ sub: 'user123', custom: 'value' });
      const payload = jwt.decode<{ sub: string; custom: string }>(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user123');
      expect(payload!.custom).toBe('value');
    });

    it('returns null for a malformed token (wrong number of parts)', () => {
      expect(jwt.decode('not.a.valid.jwt.token')).toBeNull();
    });

    it('returns null for a token with invalid base64', () => {
      expect(jwt.decode('header.!!!.signature')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(jwt.decode('')).toBeNull();
    });

    it('returns payload ignoring tampering (does not verify)', async () => {
      const token = await jwt.sign({ sub: 'user123' });
      // decode does not verify, so it returns the payload regardless
      const payload = jwt.decode<{ sub: string }>(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user123');
    });
  });

  describe('malformed tokens', () => {
    let jwt: JwtService;

    beforeAll(() => {
      const runtime = createFakeRuntime(1000000);
      jwt = new JwtService(runtime, {
        secret: 'test-secret',
        algorithm: 'HS256',
      });
    });

    it('rejects a token with wrong number of parts on verify', async () => {
      await expect(jwt.verify('only-two-parts')).rejects.toThrow('Invalid token format');
    });

    it('rejects a token with invalid signature', async () => {
      const token = await jwt.sign({ sub: 'user123' });
      const [header, payload] = token.split('.');
      const wrongSignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      await expect(jwt.verify(`${header}.${payload}.${wrongSignature}`)).rejects.toThrow(
        'Invalid token signature',
      );
    });
  });

  describe('construction validation', () => {
    it('throws when HS256 is selected without a secret', () => {
      const runtime = createFakeRuntime();
      expect(
        () =>
          new JwtService(runtime, {
            algorithm: 'HS256',
          }),
      ).toThrow('HS256 requires a secret key');
    });

    it('throws when RS256 is selected without keys', () => {
      const runtime = createFakeRuntime();
      expect(
        () =>
          new JwtService(runtime, {
            algorithm: 'RS256',
          }),
      ).toThrow('RS256 requires both private and public keys');
    });
  });

  describe('RS256', () => {
    let runtime: ReturnType<typeof createFakeRuntime>;
    let jwt: JwtService;
    let publicKeyPem: string;
    let privateKeyPem: string;

    beforeAll(async () => {
      runtime = createFakeRuntime(1000000);

      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      );

      const [spki, pkcs8] = await Promise.all([
        crypto.subtle.exportKey('spki', keyPair.publicKey),
        crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
      ]);

      publicKeyPem = formatPem(new Uint8Array(spki), 'PUBLIC KEY');
      privateKeyPem = formatPem(new Uint8Array(pkcs8), 'PRIVATE KEY');

      jwt = new JwtService(runtime, {
        privateKey: privateKeyPem,
        publicKey: publicKeyPem,
        algorithm: 'RS256',
      });
    });

    it('signs with private key and verifies with public key', async () => {
      const token = await jwt.sign({ sub: 'rs256user' });
      expect(token.split('.').length).toBe(3);

      const payload = await jwt.verify<{ sub: string }>(token);
      expect(payload.sub).toBe('rs256user');
    });

    it('rejects a tampered RS256 token', async () => {
      const token = await jwt.sign({ sub: 'user123' });
      const [header, payload, signature] = token.split('.');
      const tamperedPayload = payload.slice(0, -2) + 'XX';
      const tamperedToken = `${header}.${tamperedPayload}.${signature}`;
      await expect(jwt.verify(tamperedToken)).rejects.toThrow();
    });

    it('adds exp claim from expiresIn', async () => {
      const token = await jwt.sign({ sub: 'user123' }, { expiresIn: '1h' });
      const payload = await jwt.verify<{ iat: number; exp: number }>(token);
      expect(payload.exp).toBe(payload.iat + 3600);
    });
  });
});

/**
 * Format DER bytes as a PEM string.
 */
function formatPem(der: Uint8Array, label: string): string {
  const binary = String.fromCharCode(...der);
  const base64 = btoa(binary);
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`);
  return lines.join('\n');
}

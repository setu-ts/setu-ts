/**
 * Tests for JwtStrategy.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { JwtStrategy } from '../../src/strategies/jwt-strategy.ts';
import { JwtService } from '../../src/services/jwt-service.ts';
import { MemoryAccessTokenRevocationStore } from '../../src/stores/access-token-revocation-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { IRequest } from '@setu-ts/common';

describe('JwtStrategy', () => {
  let jwt: JwtService;
  let strategy: JwtStrategy;

  beforeAll(() => {
    const runtime = createFakeRuntime(1000000);
    jwt = new JwtService(runtime, {
      secret: 'test-secret-key',
      algorithm: 'HS256',
    });
    strategy = new JwtStrategy({ jwtService: jwt });
  });

  function createRequest(headers: Record<string, string> = {}): IRequest {
    const h = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      h.set(key, value);
    }
    return {
      method: 'GET',
      url: 'http://localhost/',
      path: '/',
      headers: h,
      json: <T>() => Promise.resolve({} as T),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    };
  }

  it('returns a principal for a valid bearer token', async () => {
    const token = await jwt.sign({
      sub: 'user123',
      roles: ['admin'],
      permissions: ['users:read'],
    });
    const request = createRequest({ authorization: `Bearer ${token}` });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('user123');
    expect(principal!.roles).toEqual(['admin']);
    expect(principal!.permissions).toEqual(['users:read']);
  });

  it('includes custom claims in principal', async () => {
    const token = await jwt.sign({
      sub: 'user123',
      email: 'user@example.com',
      department: 'eng',
    });
    const request = createRequest({ authorization: `Bearer ${token}` });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.claims).toBeDefined();
    expect(principal!.claims!.email).toBe('user@example.com');
    expect(principal!.claims!.department).toBe('eng');
  });

  it('returns null when authorization header is absent', async () => {
    const request = createRequest();
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('returns null for wrong scheme', async () => {
    const token = await jwt.sign({ sub: 'user123' });
    const request = createRequest({ authorization: `Basic ${token}` });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('returns null for an invalid token', async () => {
    const request = createRequest({ authorization: 'Bearer invalid.token.here' });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('rejects a refresh token as a bearer access credential', async () => {
    const token = await jwt.sign({ sub: 'user123', type: 'refresh', jti: 'refresh-1' });
    const request = createRequest({ authorization: `Bearer ${token}` });

    expect(await strategy.authenticate(request)).toBeNull();
  });

  it('rejects a revoked typed access token when a store is configured', async () => {
    const runtime = createFakeRuntime(1000000);
    const store = new MemoryAccessTokenRevocationStore(runtime);
    const revokingStrategy = new JwtStrategy({
      jwtService: jwt,
      accessTokenRevocationStore: store,
    });
    const token = await jwt.sign({ sub: 'user123', type: 'access', jti: 'access-1' });
    await store.revoke('access-1', runtime.now() + 1000);

    expect(
      await revokingStrategy.authenticate(createRequest({ authorization: `Bearer ${token}` })),
    ).toBeNull();
  });

  it('keeps direct JWT access tokens compatible when they have no type claim', async () => {
    const token = await jwt.sign({ sub: 'user123' });

    expect(
      await strategy.authenticate(createRequest({ authorization: `Bearer ${token}` })),
    ).not.toBeNull();
  });

  it('returns null when scheme is missing', async () => {
    const request = createRequest({ authorization: 'justtoken' });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('respects custom header name', async () => {
    const customStrategy = new JwtStrategy({
      jwtService: jwt,
      header: 'x-jwt',
    });
    const token = await jwt.sign({ sub: 'user123' });
    const request = createRequest({ 'x-jwt': `Bearer ${token}` });
    const principal = await customStrategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('user123');
  });

  it('respects custom scheme', async () => {
    const customStrategy = new JwtStrategy({
      jwtService: jwt,
      scheme: 'token',
    });
    const token = await jwt.sign({ sub: 'user123' });
    const request = createRequest({ authorization: `token ${token}` });
    const principal = await customStrategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('user123');
  });

  it('does not include standard claims in the claims object', async () => {
    const token = await jwt.sign({
      sub: 'user123',
      custom: 'value',
    });
    const request = createRequest({ authorization: `Bearer ${token}` });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.claims).toBeDefined();
    expect(principal!.claims!.custom).toBe('value');
    expect(principal!.claims!.sub).toBeUndefined();
    expect(principal!.claims!.iat).toBeUndefined();
  });

  it('does not expose token type or identifier in principal claims', async () => {
    const token = await jwt.sign({ sub: 'user123', type: 'access', jti: 'access-1' });
    const principal = await strategy.authenticate(
      createRequest({ authorization: `Bearer ${token}` }),
    );

    expect(principal?.claims).toBeUndefined();
  });

  it('fills scopes from the scope claim', async () => {
    const token = await jwt.sign({ sub: 'user123', scope: 'tools:read tools:list' });
    const principal = await strategy.authenticate(
      createRequest({ authorization: `Bearer ${token}` }),
    );
    expect(principal?.scopes).toEqual(['tools:read', 'tools:list']);
    // The raw claim still travels in claims, exactly as before.
    expect(principal?.claims?.scope).toBe('tools:read tools:list');
  });

  it('audit F1 keeps malformed scp authenticated with empty scopes', async () => {
    const token = await jwt.sign({ sub: 'user123', scp: ['tools:read'] });
    const principal = await strategy.authenticate(
      createRequest({ authorization: `Bearer ${token}` }),
    );
    expect(principal?.scopes).toEqual(['tools:read']);

    const malformed = await jwt.sign({ sub: 'user123', scp: ['tools:read', 7] });
    const noScopes = await strategy.authenticate(
      createRequest({ authorization: `Bearer ${malformed}` }),
    );
    expect(noScopes).not.toBeNull();
    expect(noScopes?.scopes).toEqual([]);
  });

  it('fills the actor from the outermost act claim', async () => {
    const token = await jwt.sign({
      sub: 'user123',
      act: { sub: 'agent', nested: 'x', act: { sub: 'prior' } },
    });
    const principal = await strategy.authenticate(
      createRequest({ authorization: `Bearer ${token}` }),
    );
    expect(principal?.actor).toEqual({ id: 'agent', claims: { sub: 'agent', nested: 'x' } });
    // The raw claim is still available where it always was.
    expect(principal?.claims?.act).toEqual({
      sub: 'agent',
      nested: 'x',
      act: { sub: 'prior' },
    });
  });

  it('refuses a token whose act claim is malformed', async () => {
    for (const act of [[], 'agent', 7, null, {}, { sub: 7 }]) {
      const token = await jwt.sign({ sub: 'user123', act });
      expect(
        await strategy.authenticate(createRequest({ authorization: `Bearer ${token}` })),
      ).toBeNull();
    }
  });

  it('has the name "jwt"', () => {
    expect(strategy.name).toBe('jwt');
  });
});

describe('M139a JWT boundaries', () => {
  const jwt = new JwtService(createFakeRuntime(1000000), {
    secret: 'test-secret-key',
    algorithm: 'HS256',
  });
  const request = (token: string, tenant?: string): IRequest =>
    ({
      headers: new Headers({ authorization: `Bearer ${token}` }),
      ...(tenant === undefined ? {} : { tenant: { id: tenant } }),
    }) as IRequest;
  it.each([undefined, 42, '', null, ['a']])('refuses unusable sub %j', async (sub) => {
    const token = await jwt.sign(sub === undefined ? {} : { sub });
    expect(await new JwtStrategy({ jwtService: jwt }).authenticate(request(token))).toBeNull();
  });
  it.each([
    ['acme', 'acme', true],
    ['globex', 'acme', false],
    [undefined, 'acme', false],
    [42, 'acme', false],
    [null, 'acme', false],
    ['', 'acme', false],
    [undefined, undefined, true],
    ['acme', undefined, false],
    [null, undefined, false],
  ] as const)('binds verified tid %j on tenant %j: %j', async (tid, tenant, allowed) => {
    const token = await jwt.sign({ sub: 'u1', ...(tid === undefined ? {} : { tid }) });
    const strategy = new JwtStrategy({ jwtService: jwt, tenantClaim: 'tid' });
    expect((await strategy.authenticate(request(token, tenant)))?.id ?? null).toBe(
      allowed ? 'u1' : null,
    );
  });
  it('keeps tenant binding opt-in', async () => {
    const token = await jwt.sign({ sub: 'u1', tid: 'globex' });
    expect(
      (await new JwtStrategy({ jwtService: jwt }).authenticate(request(token, 'acme')))?.id,
    ).toBe('u1');
  });
});

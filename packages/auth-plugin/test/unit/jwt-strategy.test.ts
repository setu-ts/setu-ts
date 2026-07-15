/**
 * Tests for JwtStrategy.
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { JwtStrategy } from '../../src/strategies/jwt-strategy.ts';
import { JwtService } from '../../src/services/jwt-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { IRequest } from '@hono-enterprise/common';

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

  it('returns unknown id when sub claim is missing', async () => {
    const token = await jwt.sign({ data: 'no-sub' });
    const request = createRequest({ authorization: `Bearer ${token}` });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('unknown');
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

  it('has the name "jwt"', () => {
    expect(strategy.name).toBe('jwt');
  });
});

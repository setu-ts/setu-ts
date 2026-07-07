import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal } from '@hono-enterprise/common';

import { createFakeRequestContext } from '../fixtures/fake-request-context.ts';
import {
  clearParameterResolvers,
  parseCookies,
  registerParameterResolver,
  resolveParameter,
  resolveParameters,
} from '../../src/resolvers/parameter-resolver.ts';

describe('parameter resolver', () => {
  beforeEach(() => {
    clearParameterResolvers();
  });

  it('resolves @Body from the JSON body', async () => {
    const ctx = createFakeRequestContext({ body: { name: 'Alice' } });
    const args = await resolveParameters(ctx, [{ index: 0, type: 'body' }]);
    expect(args).toEqual([{ name: 'Alice' }]);
  });

  it('resolves @Query(name) and the whole query object', async () => {
    const ctx = createFakeRequestContext({ query: { name: 'Alice', page: '2' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'query', name: 'name' })).toBe('Alice');
    expect(await resolveParameter(ctx, { index: 0, type: 'query' })).toEqual({
      name: 'Alice',
      page: '2',
    });
  });

  it('resolves @Param(name)', async () => {
    const ctx = createFakeRequestContext({ params: { id: '42' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'param', name: 'id' })).toBe('42');
  });

  it('resolves @Header(name)', async () => {
    const ctx = createFakeRequestContext({ headers: { 'x-request-id': 'rid-1' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'header', name: 'x-request-id' })).toBe(
      'rid-1',
    );
  });

  it('resolves @Cookie(name) and the whole cookie object', async () => {
    const ctx = createFakeRequestContext({ cookies: { session: 'abc', theme: 'dark' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'cookie', name: 'session' })).toBe('abc');
    expect(await resolveParameter(ctx, { index: 0, type: 'cookie' })).toEqual({
      session: 'abc',
      theme: 'dark',
    });
  });

  it('resolves @CurrentUser from ctx.request.user', async () => {
    const user: IPrincipal = { id: 'user-1', roles: ['admin'] };
    const ctx = createFakeRequestContext({ user });
    expect(await resolveParameter(ctx, { index: 0, type: 'custom', customType: 'current-user' }))
      .toBe(user);
  });

  it('resolves a custom parameter via a registered resolver', async () => {
    const ctx = createFakeRequestContext();
    registerParameterResolver('current-tenant', () => 'tenant-1');
    expect(await resolveParameter(ctx, { index: 0, type: 'custom', customType: 'current-tenant' }))
      .toBe('tenant-1');
  });

  it('passes captured metadata to a custom resolver', async () => {
    const ctx = createFakeRequestContext();
    registerParameterResolver('echo', (_c, metadata) => metadata?.['value']);
    expect(
      await resolveParameter(ctx, {
        index: 0,
        type: 'custom',
        customType: 'echo',
        metadata: { value: 42 },
      }),
    ).toBe(42);
  });

  it('returns undefined for an unregistered custom type', async () => {
    const ctx = createFakeRequestContext();
    expect(
      await resolveParameter(ctx, { index: 0, type: 'custom', customType: 'unknown' }),
    ).toBeUndefined();
  });

  it('places arguments by index, leaving gaps undefined', async () => {
    const ctx = createFakeRequestContext({ query: { q: '1' }, params: { id: '9' } });
    const args = await resolveParameters(ctx, [
      { index: 2, type: 'param', name: 'id' },
      { index: 0, type: 'query', name: 'q' },
    ]);
    expect(args[0]).toBe('1');
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBe('9');
  });

  it('parseCookies parses a Cookie header', () => {
    expect(parseCookies(new Headers({ cookie: 'a=1; b=2' }))).toEqual({ a: '1', b: '2' });
  });

  it('parseCookies returns empty when no Cookie header is present', () => {
    expect(parseCookies(new Headers())).toEqual({});
  });
});

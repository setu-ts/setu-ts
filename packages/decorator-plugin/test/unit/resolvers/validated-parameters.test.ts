/**
 * Unit tests for the E2 (M70n) behaviour: `@Body`/`@Query`/`@Param`
 * resolution prefers the validated value written to request state under
 * {@linkcode validatedStateKey}, falling back to the raw request value when
 * absent; `@Header`/`@Cookie` are deliberately unchanged.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { validatedStateKey } from '@setu-ts/common';

import { createFakeRequestContext } from '../../fixtures/fake-request-context.ts';
import { resolveParameter } from '../../../src/resolvers/parameter-resolver.ts';

describe('parameter resolver — validated values', () => {
  it('resolves @Body from the validated state key when present', async () => {
    const ctx = createFakeRequestContext({ body: { name: '  raw  ' } });
    const transformed = { name: 'RAW' };
    // Written by validation middleware; the raw body differs, so only the
    // state read can produce this value.
    ctx.state.set(validatedStateKey('body'), transformed);
    const value = await resolveParameter(ctx, { index: 0, type: 'body' });
    expect(value).toBe(transformed);
  });

  it('resolves @Query(name) to its OWN member of the validated record', async () => {
    const ctx = createFakeRequestContext({ query: { page: '2' } });
    // The middleware validates the WHOLE request part, but a parameter bound
    // WITH a name receives only its own member — `@Query('page')` is `2`,
    // never the `{ page: 2 }` record (the documented NAMED-value contract).
    const validated = { page: 2 };
    ctx.state.set(validatedStateKey('query'), validated);
    expect(await resolveParameter(ctx, { index: 0, type: 'query', name: 'page' })).toBe(
      validated.page,
    );
  });

  it('resolves the whole query object from the validated state key when present', async () => {
    const ctx = createFakeRequestContext({ query: { page: '2' } });
    const validated = { page: 2 };
    ctx.state.set(validatedStateKey('query'), validated);
    expect(await resolveParameter(ctx, { index: 0, type: 'query' })).toBe(validated);
  });

  it('resolves @Param(name) to its OWN member of the validated record', async () => {
    const ctx = createFakeRequestContext({ params: { id: 'raw-id' } });
    const validated = { id: 'coerced-id' };
    ctx.state.set(validatedStateKey('params'), validated);
    expect(await resolveParameter(ctx, { index: 0, type: 'param', name: 'id' })).toBe(
      validated.id,
    );
  });

  it('resolves @Body() (no name) to the whole validated object', async () => {
    const ctx = createFakeRequestContext({ body: { name: 'Alice' } });
    const validated = { name: 'ALICE' };
    ctx.state.set(validatedStateKey('body'), validated);
    expect(await resolveParameter(ctx, { index: 0, type: 'body' })).toBe(validated);
  });

  it('falls back to the raw body when no validated value was written', async () => {
    const ctx = createFakeRequestContext({ body: { name: 'Alice' } });
    const value = await resolveParameter(ctx, { index: 0, type: 'body' });
    await expect(value).toEqual({ name: 'Alice' });
  });

  it('falls back to the raw query when no validated value was written', async () => {
    const ctx = createFakeRequestContext({ query: { page: '2' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'query', name: 'page' })).toBe('2');
    expect(await resolveParameter(ctx, { index: 0, type: 'query' })).toEqual({ page: '2' });
  });

  it('falls back to the raw param when no validated value was written', async () => {
    const ctx = createFakeRequestContext({ params: { id: '42' } });
    expect(await resolveParameter(ctx, { index: 0, type: 'param', name: 'id' })).toBe('42');
  });

  it('honours a validated body of null via the presence check', async () => {
    const ctx = createFakeRequestContext({ body: { name: 'Alice' } });
    // A truthiness check on `get` would skip this and return the raw body.
    ctx.state.set(validatedStateKey('body'), null);
    expect(await resolveParameter(ctx, { index: 0, type: 'body' })).toBe(null);
  });

  it('uses exactly the per-target keys, not a shared one', async () => {
    // A validated BODY value must not satisfy a QUERY parameter and vice
    // versa — each decorator reads its own target's key.
    const ctx = createFakeRequestContext({
      body: { name: 'raw-body' },
      query: { page: '2' },
      params: { id: '42' },
    });
    ctx.state.set(validatedStateKey('body'), { name: 'validated-body' });
    expect(await resolveParameter(ctx, { index: 0, type: 'query', name: 'page' })).toBe('2');
    expect(await resolveParameter(ctx, { index: 0, type: 'param', name: 'id' })).toBe('42');
    const validatedQuery = { page: 9 };
    const validatedParams = { id: 'nine' };
    ctx.state.set(validatedStateKey('query'), validatedQuery);
    ctx.state.set(validatedStateKey('params'), validatedParams);
    await expect(resolveParameter(ctx, { index: 0, type: 'body' })).toEqual({
      name: 'validated-body',
    });
    expect(await resolveParameter(ctx, { index: 0, type: 'query', name: 'page' })).toBe(9);
    expect(await resolveParameter(ctx, { index: 0, type: 'param', name: 'id' })).toBe('nine');
  });

  it('leaves @Header resolving raw even when a headers value is in state', async () => {
    const ctx = createFakeRequestContext({ headers: { 'content-type': 'application/json' } });
    // Even a same-shaped record under the headers key must NOT be read.
    ctx.state.set(validatedStateKey('headers'), { 'content-type': 'text/plain' });
    expect(
      await resolveParameter(ctx, { index: 0, type: 'header', name: 'content-type' }),
    ).toBe('application/json');
  });

  it('leaves @Header case-insensitive as today', async () => {
    const ctx = createFakeRequestContext({ headers: { 'Content-Type': 'application/json' } });
    expect(
      await resolveParameter(ctx, { index: 0, type: 'header', name: 'content-type' }),
    ).toBe('application/json');
  });

  it('leaves @Cookie resolving raw even when a cookies value is in state', async () => {
    const ctx = createFakeRequestContext({ cookies: { session: 'raw-token' } });
    ctx.state.set(validatedStateKey('cookies'), { session: 'validated-token' });
    expect(await resolveParameter(ctx, { index: 0, type: 'cookie', name: 'session' })).toBe(
      'raw-token',
    );
  });
});

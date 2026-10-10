/**
 * The two built-in scope sources: the request tenant and a route parameter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequestContext } from '../../src/http.ts';
import { scopeFromParam, scopeFromTenant } from '../../src/services/scope-sources.ts';

function context(
  options: { tenant?: string; params?: Record<string, string> } = {},
): IRequestContext {
  return {
    request: options.tenant === undefined ? {} : { tenant: { id: options.tenant } },
    params: options.params ?? {},
  } as unknown as IRequestContext;
}

describe('scopeFromTenant', () => {
  it('reads the resolved request tenant', () => {
    expect(scopeFromTenant()(context({ tenant: 'acme' }))).toEqual({ type: 'tenant', id: 'acme' });
  });

  it('uses the given scope type', () => {
    expect(scopeFromTenant('account')(context({ tenant: 'acme' }))).toEqual({
      type: 'account',
      id: 'acme',
    });
  });

  it('is unresolved when no tenant was resolved', () => {
    expect(scopeFromTenant()(context())).toBeUndefined();
  });

  it('is unresolved for an empty or over-long tenant id, never truncated', () => {
    expect(scopeFromTenant()(context({ tenant: '' }))).toBeUndefined();
    expect(scopeFromTenant()(context({ tenant: 'x'.repeat(257) }))).toBeUndefined();
    expect(scopeFromTenant()(context({ tenant: 'x'.repeat(256) }))?.id.length).toBe(256);
  });

  it('refuses an illegal scope type at construction', () => {
    expect(() => scopeFromTenant('Tenant')).toThrow(TypeError);
    expect(() => scopeFromTenant(7 as unknown as string)).toThrow('[number]');
  });
});

describe('scopeFromParam', () => {
  it('reads the named route parameter', () => {
    expect(scopeFromParam('orgId', 'organisation')(context({ params: { orgId: 'o1' } }))).toEqual({
      type: 'organisation',
      id: 'o1',
    });
  });

  it('is unresolved when the parameter is absent or empty', () => {
    const source = scopeFromParam('orgId', 'organisation');
    expect(source(context())).toBeUndefined();
    expect(source(context({ params: { orgId: '' } }))).toBeUndefined();
  });

  it('never reads an inherited member as a parameter', () => {
    expect(scopeFromParam('constructor', 'organisation')(context())).toBeUndefined();
  });

  it('refuses an empty parameter name and an illegal scope type', () => {
    expect(() => scopeFromParam('', 'organisation')).toThrow(TypeError);
    expect(() => scopeFromParam('orgId', 'Org')).toThrow(TypeError);
  });
});

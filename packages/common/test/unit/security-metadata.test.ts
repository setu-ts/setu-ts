/**
 * Tests for the route security metadata brand.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { SECURITY_METADATA, securityMetadataOf, withSecurityMetadata } from '../../src/index.ts';
import type { MiddlewareFunction } from '../../src/index.ts';

/** A middleware that does nothing but continue — enough to be branded. */
function passthrough(): MiddlewareFunction {
  return async (_ctx, next) => {
    await next();
  };
}

describe('route security metadata', () => {
  it('should round-trip the metadata it was branded with', () => {
    const branded = withSecurityMetadata(passthrough(), { authenticated: true });

    expect(securityMetadataOf(branded)).toEqual({ authenticated: true });
  });

  it('should round-trip the public brand, which is not the same as absent', () => {
    const branded = withSecurityMetadata(passthrough(), { authenticated: false });

    expect(securityMetadataOf(branded)).toEqual({ authenticated: false });
    expect(securityMetadataOf(branded)).not.toBeUndefined();
  });

  it('should return undefined for an unbranded middleware', () => {
    expect(securityMetadataOf(passthrough())).toBeUndefined();
  });

  it('should return the SAME function reference, not a wrapper', () => {
    const original = passthrough();

    expect(withSecurityMetadata(original, { authenticated: true })).toBe(original);
  });

  it('should leave the middleware callable and behaviourally unchanged', async () => {
    let continued = false;
    const branded = withSecurityMetadata(
      (async (_ctx, next) => {
        await next();
      }) as MiddlewareFunction,
      { authenticated: true },
    );

    await branded(
      {} as Parameters<MiddlewareFunction>[0],
      (() => {
        continued = true;
        return Promise.resolve();
      }) as Parameters<MiddlewareFunction>[1],
    );

    expect(continued).toBe(true);
  });

  it('should brand invisibly to enumeration, JSON, and spread', () => {
    const branded = withSecurityMetadata(passthrough(), { authenticated: true });

    // A symbol-keyed non-enumerable property must not leak into any of the
    // ways a consumer might inspect or copy the function.
    expect(Object.keys(branded)).toEqual([]);
    expect(JSON.stringify({ ...branded })).toBe('{}');
  });

  it('should use a REGISTRY symbol so two copies of common agree', () => {
    // `Symbol.for` is load-bearing: with a locally-created symbol, a second
    // copy of this package in one process would read undefined on every
    // branded middleware and silently derive nothing.
    expect(SECURITY_METADATA).toBe(Symbol.for('setu.security.metadata'));
  });

  it('should treat a foreign value under the same symbol as absent', () => {
    const impostor = passthrough();
    Object.defineProperty(impostor, SECURITY_METADATA, { value: { authenticated: 'yes' } });

    expect(securityMetadataOf(impostor)).toBeUndefined();
  });

  it('should round-trip an OAuth scope list', () => {
    const branded = withSecurityMetadata(passthrough(), {
      authenticated: true,
      scopes: ['tools:read', 'tools:list'],
    });

    expect(securityMetadataOf(branded)).toEqual({
      authenticated: true,
      scopes: ['tools:read', 'tools:list'],
    });
  });

  it('should accept an empty scope list, which is distinct from absent', () => {
    const branded = withSecurityMetadata(passthrough(), { authenticated: true, scopes: [] });

    expect(securityMetadataOf(branded)).toEqual({ authenticated: true, scopes: [] });
  });

  it('should treat a present scopes value that is not a string array as absent', () => {
    const values: unknown[] = ['tools:read', null, 7, { 0: 'tools:read' }];
    for (const value of values) {
      const impostor = passthrough();
      Object.defineProperty(impostor, SECURITY_METADATA, {
        value: { authenticated: true, scopes: value },
      });

      expect(securityMetadataOf(impostor)).toBeUndefined();
    }
  });

  it('should reject a scope list containing a non-string entry', () => {
    const impostor = passthrough();
    Object.defineProperty(impostor, SECURITY_METADATA, {
      value: { authenticated: true, scopes: ['tools:read', 7] },
    });

    expect(securityMetadataOf(impostor)).toBeUndefined();
  });

  it('should treat a non-object under the symbol as absent', () => {
    const impostor = passthrough();
    Object.defineProperty(impostor, SECURITY_METADATA, { value: 'true' });

    expect(securityMetadataOf(impostor)).toBeUndefined();
  });

  it('should treat null under the symbol as absent', () => {
    const impostor = passthrough();
    Object.defineProperty(impostor, SECURITY_METADATA, { value: null });

    expect(securityMetadataOf(impostor)).toBeUndefined();
  });
  it('should round-trip forbids: true (M137b)', () => {
    const branded = withSecurityMetadata(passthrough(), { authenticated: true, forbids: true });

    expect(securityMetadataOf(branded)).toEqual({ authenticated: true, forbids: true });
  });

  it.each([false, 'yes', 1])('should treat forbids: %j as an invalid brand', (forbids) => {
    const impostor = passthrough();
    Object.defineProperty(impostor, SECURITY_METADATA, { value: { authenticated: true, forbids } });

    expect(securityMetadataOf(impostor)).toBeUndefined();
  });
});

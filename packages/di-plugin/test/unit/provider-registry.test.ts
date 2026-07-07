import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ProviderRegistry } from '../../src/container/provider-registry.ts';

describe('ProviderRegistry', () => {
  describe('register', () => {
    it('stores a provider entry under a token', () => {
      const reg = new ProviderRegistry();
      const entry = { provider: { useValue: 42 }, scope: 'singleton' as const };

      reg.register('answer', entry);

      expect(reg.get('answer')).toBe(entry);
    });

    it('throws when the same token is registered twice', () => {
      const reg = new ProviderRegistry();
      reg.register('dup', { provider: { useValue: 1 }, scope: 'singleton' });

      expect(() => reg.register('dup', { provider: { useValue: 2 }, scope: 'transient' })).toThrow(
        /already registered/,
      );
    });

    it('allows different tokens in the same registry', () => {
      const reg = new ProviderRegistry();
      reg.register('a', { provider: { useValue: 1 }, scope: 'singleton' });
      reg.register('b', { provider: { useValue: 2 }, scope: 'singleton' });

      expect(reg.has('a')).toBe(true);
      expect(reg.has('b')).toBe(true);
    });
  });

  describe('get', () => {
    it('returns undefined for an unregistered token', () => {
      const reg = new ProviderRegistry();
      expect(reg.get('nope')).toBeUndefined();
    });

    it('returns the entry from a parent registry', () => {
      const parent = new ProviderRegistry();
      parent.register('parent-token', { provider: { useValue: 'parent' }, scope: 'singleton' });
      const child = parent.createChild();

      expect(child.get('parent-token')?.provider).toEqual({ useValue: 'parent' });
    });
  });

  describe('has', () => {
    it('returns false for a token registered in neither self nor parent', () => {
      const parent = new ProviderRegistry();
      const child = parent.createChild();
      expect(child.has('ghost')).toBe(false);
    });

    it('returns true for a token in the parent', () => {
      const parent = new ProviderRegistry();
      parent.register('inherited', { provider: { useValue: 1 }, scope: 'singleton' });
      const child = parent.createChild();

      expect(child.has('inherited')).toBe(true);
    });

    it('returns true for a locally registered token', () => {
      const reg = new ProviderRegistry();
      reg.register('local', { provider: { useValue: 1 }, scope: 'singleton' });
      expect(reg.has('local')).toBe(true);
    });
  });

  describe('createChild', () => {
    it('produces a registry that does not affect the parent on local registration', () => {
      const parent = new ProviderRegistry();
      const child = parent.createChild();
      child.register('child-only', { provider: { useValue: 'child' }, scope: 'singleton' });

      expect(parent.has('child-only')).toBe(false);
      expect(child.has('child-only')).toBe(true);
    });
  });
});

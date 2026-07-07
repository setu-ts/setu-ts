import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ScopeManager } from '../../src/container/scope-manager.ts';

describe('ScopeManager', () => {
  describe('singleton cache', () => {
    it('stores and retrieves a singleton', () => {
      const sm = new ScopeManager();
      const obj = { id: 's1' };

      sm.setSingleton('tok', obj);

      expect(sm.hasSingleton('tok')).toBe(true);
      expect(sm.getSingleton('tok')).toBe(obj);
    });

    it('reports false for an unset singleton', () => {
      const sm = new ScopeManager();
      expect(sm.hasSingleton('nope')).toBe(false);
      expect(sm.getSingleton('nope')).toBeUndefined();
    });
  });

  describe('scoped cache', () => {
    it('stores and retrieves a scoped instance', () => {
      const sm = new ScopeManager();
      const obj = { id: 'sc1' };

      sm.setScoped('tok', obj);

      expect(sm.hasScoped('tok')).toBe(true);
      expect(sm.getScoped('tok')).toBe(obj);
    });

    it('reports false for an unset scoped instance', () => {
      const sm = new ScopeManager();
      expect(sm.hasScoped('nope')).toBe(false);
      expect(sm.getScoped('nope')).toBeUndefined();
    });
  });

  describe('createChild', () => {
    it('shares the singleton map with the parent', () => {
      const parent = new ScopeManager();
      parent.setSingleton('shared', { v: 1 });
      const child = parent.createChild();

      // Child sees parent's singleton
      expect(child.getSingleton('shared')).toEqual({ v: 1 });

      // Singleton set on child is visible to parent (shared map)
      child.setSingleton('from-child', { v: 2 });
      expect(parent.getSingleton('from-child')).toEqual({ v: 2 });
    });

    it('gives the child an independent scoped map', () => {
      const parent = new ScopeManager();
      parent.setScoped('parent-scoped', { v: 1 });
      const child = parent.createChild();

      // Child does NOT see parent's scoped instances
      expect(child.hasScoped('parent-scoped')).toBe(false);

      // Child can set its own scoped instance
      child.setScoped('child-scoped', { v: 2 });
      expect(child.getScoped('child-scoped')).toEqual({ v: 2 });
      expect(parent.hasScoped('child-scoped')).toBe(false);
    });
  });

  describe('default constructor', () => {
    it('creates fresh maps when no arguments are given', () => {
      const sm = new ScopeManager();
      expect(sm.hasSingleton('x')).toBe(false);
      expect(sm.hasScoped('x')).toBe(false);
    });

    it('accepts explicitly provided maps', () => {
      const singletons = new Map<string, unknown>([['pre', 99]]);
      const scoped = new Map<string, unknown>([['sc', 77]]);
      const sm = new ScopeManager(singletons, scoped);

      expect(sm.getSingleton('pre')).toBe(99);
      expect(sm.getScoped('sc')).toBe(77);
    });
  });
});

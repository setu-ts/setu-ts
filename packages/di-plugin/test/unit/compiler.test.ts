import { describe, expect, it, vi } from 'vitest';
import { createToken } from '@setu-ts/common';
import { ContainerValidationError, createContainer } from '../../src/index.ts';
import { CircularDetector, ProviderRegistry } from '../../src/index.ts';

describe('graph validation', () => {
  it('resolves compiled dependency edges without registry reads or detector work', () => {
    const c = createContainer();
    c.register('leaf', { useFactory: () => ({}) }, { scope: 'scoped' });
    c.register(
      'holder',
      { useFactory: (leaf: object) => ({ leaf }), inject: ['leaf'] },
      { scope: 'transient' },
    );
    c.close();
    const lookup = vi.spyOn(ProviderRegistry.prototype, 'get').mockImplementation(() => {
      throw new Error('runtime graph lookup');
    });
    const enter = vi.spyOn(CircularDetector.prototype, 'enter').mockImplementation(() => {
      throw new Error('runtime cycle detection');
    });
    try {
      const scope = c.createScope();
      expect(scope.resolve<{ leaf: object }>('holder').leaf).toBe(scope.resolve('leaf'));
      expect(lookup).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      enter.mockRestore();
    }
  });
  it.each([
    { kind: 'missing', scope: 'transient' as const, inject: ['missing'], pattern: /A → missing/ },
    { kind: 'cycle', scope: 'transient' as const, inject: ['A'], pattern: /A → A/ },
    { kind: 'captive', scope: 'singleton' as const, inject: ['scoped'], pattern: /A → scoped/ },
  ])('reports $kind without instantiating', ({ kind, scope, inject, pattern }) => {
    const create = vi.fn(() => ({}));
    const c = createContainer();
    c.register('scoped', { useFactory: create, inject: [] }, { scope: 'scoped' });
    c.register('A', { useFactory: create, inject }, { scope });
    try {
      c.close();
      throw new Error('expected invalid graph');
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerValidationError);
      expect((error as ContainerValidationError).findings[0]?.kind).toBe(kind);
      expect((error as Error).message).toMatch(pattern);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('aggregates missing, cycle, and captive through multiple transients', () => {
    const c = createContainer();
    c.register('A', { useFactory: () => ({}), inject: ['B', 'missing'] });
    c.register('B', { useFactory: () => ({}), inject: ['C'] }, { scope: 'transient' });
    c.register('C', { useFactory: () => ({}), inject: ['scoped'] }, { scope: 'transient' });
    c.register('scoped', { useValue: {} }, { scope: 'scoped' });
    c.register('cycle', { useFactory: () => 1, inject: ['cycle'] });
    expect(() => c.close()).toThrow(/captive: A → B → C → scoped/);
    try {
      c.close();
    } catch (error) {
      expect(new Set((error as ContainerValidationError).findings.map((f) => f.kind))).toEqual(
        new Set(['captive', 'missing', 'cycle']),
      );
    }
  });

  it('permits absent optional deps, validates present optionals, and lists opaque factories', () => {
    const c = createContainer();
    c.register('optional', {
      useFactory: (value: unknown) => value,
      inject: [{ token: 'absent', optional: true }],
    });
    c.register('opaque', { useFactory: () => 7 });
    c.close();
    expect(c.resolve('optional')).toBeUndefined();
    expect(c.resolve('opaque')).toBe(7);
    expect(c.opaqueTokens()).toEqual(['opaque']);
    const invalid = createContainer();
    invalid.register('optional', {
      useFactory: () => 0,
      inject: [{ token: 'present', optional: true }],
    });
    invalid.register('present', { useFactory: () => 0, inject: ['missing'] });
    expect(() => invalid.close()).toThrow(/missing/);
  });

  it('checks external leaves using has only, resolves once lazily, and never disposes them', () => {
    const value = {};
    const resolve = vi.fn(() => value);
    const c = createContainer({
      autoRegister: true,
      externalResolver: { has: (token) => token === 'external', resolve },
    });
    c.register('user', { useFactory: (value: unknown) => value, inject: ['external'] });
    c.close();
    expect(resolve).not.toHaveBeenCalled();
    expect(c.createScope().resolve('user')).toBe(value);
    expect(c.resolve('external')).toBe(value);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(c.dispose()).toBeUndefined();
  });

  it('uses identity for equally named tokens and reports real cycles', () => {
    const first = createToken<object>('same');
    const second = createToken<object>('same');
    const c = createContainer();
    c.register(first, { useFactory: (value: object) => value, inject: [second] });
    c.register(second, { useValue: {} });
    c.close();
    expect(c.resolve(first)).toBe(c.resolve(second));
    const cycle = createContainer();
    cycle.register(first, { useFactory: () => ({}), inject: [second] });
    cycle.register(second, { useFactory: () => ({}), inject: [first] });
    expect(() => cycle.close()).toThrow(/cycle: same → same → same/);
  });
});

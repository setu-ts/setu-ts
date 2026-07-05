import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';

describe('ServiceRegistry', () => {
  it('should register and get a service', () => {
    const registry = new ServiceRegistry();
    const service = { name: 'test' };
    registry.register('test-service', service);
    expect(registry.get('test-service')).toBe(service);
  });

  it('should throw when getting unregistered token', () => {
    const registry = new ServiceRegistry();
    expect(() => registry.get('missing')).toThrow(
      "No service registered for capability 'missing'",
    );
  });

  it('should support has()', () => {
    const registry = new ServiceRegistry();
    expect(registry.has('test')).toBe(false);
    registry.register('test', {});
    expect(registry.has('test')).toBe(true);
  });

  it('should support getAll with multi flag', () => {
    const registry = new ServiceRegistry();
    registry.register('multi', { id: 1 }, { multi: true });
    registry.register('multi', { id: 2 }, { multi: true });
    const all = registry.getAll('multi');
    expect(all.length).toBe(2);
    expect(all[0]).toEqual({ id: 1 });
    expect(all[1]).toEqual({ id: 2 });
  });

  it('should support lazy factory registration', () => {
    const registry = new ServiceRegistry();
    let called = 0;
    registry.registerFactory('lazy', () => {
      called++;
      return { value: 42 };
    });
    expect(called).toBe(0);
    expect(registry.get('lazy')).toEqual({ value: 42 });
    expect(called).toBe(1);
    // Factory cached — second get should not call again
    expect(registry.get('lazy')).toEqual({ value: 42 });
    expect(called).toBe(1);
  });

  it('should throw on duplicate registration without override', () => {
    const registry = new ServiceRegistry();
    registry.register('dup', { a: 1 });
    expect(() => registry.register('dup', { a: 2 })).toThrow(
      "Capability 'dup' is already registered",
    );
  });

  it('should allow override', () => {
    const registry = new ServiceRegistry();
    registry.register('override', { a: 1 });
    registry.register('override', { a: 2 }, { override: true });
    expect(registry.get('override')).toEqual({ a: 2 });
  });

  it('should support unregister', () => {
    const registry = new ServiceRegistry();
    registry.register('remove', { a: 1 });
    expect(registry.unregister('remove')).toBe(true);
    expect(registry.has('remove')).toBe(false);
    expect(registry.unregister('missing')).toBe(false);
  });

  it('should support child scope with parent fallback', () => {
    const parent = new ServiceRegistry();
    parent.register('shared', { from: 'parent' });
    const child = parent.createChild();

    // Child inherits parent service
    expect(child.get('shared')).toEqual({ from: 'parent' });

    // Child can shadow
    child.register('shared', { from: 'child' });
    expect(child.get('shared')).toEqual({ from: 'child' });
    // Parent unaffected
    expect(parent.get('shared')).toEqual({ from: 'parent' });
  });

  it('should have good error message for missing token', () => {
    const registry = new ServiceRegistry();
    try {
      registry.get('nonexistent');
    } catch (e) {
      expect((e as Error).message).toContain('nonexistent');
      expect((e as Error).message).toContain('CAPABILITIES');
    }
  });
});

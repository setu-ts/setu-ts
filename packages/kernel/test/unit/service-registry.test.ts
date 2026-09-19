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

  describe('getAll - edge cases', () => {
    it('returns empty array for unregistered token', () => {
      const registry = new ServiceRegistry();
      const all = registry.getAll('nonexistent');

      expect(all).toEqual([]);
    });

    it('includes single registration in getAll', () => {
      const registry = new ServiceRegistry();
      registry.register('single', { id: 1 });
      registry.register('multi', { id: 2 }, { multi: true });

      const all = registry.getAll('multi');

      expect(all.length).toBe(1);
      expect(all[0]).toEqual({ id: 2 });
    });
  });

  describe('has - inheritance', () => {
    it('returns true for parent registration', () => {
      const parent = new ServiceRegistry();
      parent.register('shared', {});

      const child = parent.createChild();

      expect(child.has('shared')).toBe(true);
    });

    it('returns false for non-existent parent registration', () => {
      const parent = new ServiceRegistry();
      const child = parent.createChild();

      expect(child.has('nonexistent')).toBe(false);
    });
  });

  describe('unregister - edge cases', () => {
    it('removes multi-registered token', () => {
      const registry = new ServiceRegistry();
      registry.register('multi', { id: 1 }, { multi: true });
      registry.register('multi', { id: 2 }, { multi: true });

      const removed = registry.unregister('multi');

      expect(removed).toBe(true);
      expect(registry.getAll('multi').length).toBe(0);
    });

    it('returns false for unregistering non-existent token', () => {
      const registry = new ServiceRegistry();

      const removed = registry.unregister('nonexistent');

      expect(removed).toBe(false);
    });
  });

  describe('factory lazy initialization', () => {
    it('caches factory result for subsequent gets', () => {
      const registry = new ServiceRegistry();
      let callCount = 0;

      registry.registerFactory('cached', () => {
        callCount++;
        return { value: callCount };
      });

      const first = registry.get('cached');
      const second = registry.get('cached');

      expect(callCount).toBe(1);
      expect(first).toBe(second);
    });

    it('caches factory result for getAll', () => {
      const registry = new ServiceRegistry();
      let callCount = 0;

      registry.registerFactory('cached', () => {
        callCount++;
        return { value: callCount };
      });

      const all = registry.getAll('cached');

      expect(callCount).toBe(1);
      expect(all.length).toBe(1);
    });
  });

  describe('child scope isolation', () => {
    it('child gets parent registration via fallback', () => {
      const parent = new ServiceRegistry();
      parent.register('shared', { from: 'parent' });

      const child = parent.createChild();

      expect(child.get('shared')).toEqual({ from: 'parent' });
      expect(child.has('shared')).toBe(true);
    });

    it('child can shadow parent registration', () => {
      const parent = new ServiceRegistry();
      parent.register('shared', { from: 'parent' });

      const child = parent.createChild();
      child.register('shared', { from: 'child' });

      expect(child.get('shared')).toEqual({ from: 'child' });
      expect(parent.get('shared')).toEqual({ from: 'parent' });
    });
  });

  describe('peekResolved', () => {
    it('returns the cached instance of a resolved registration', () => {
      const registry = new ServiceRegistry();
      const instance = { kind: 'instance' };
      registry.register('svc', instance);

      expect(registry.peekResolved<{ kind: string }>('svc')).toBe(instance);
    });

    it('returns undefined for an unresolved factory without executing it', () => {
      const registry = new ServiceRegistry();
      let constructed = 0;
      registry.registerFactory('lazy', () => {
        constructed++;
        return { built: true };
      });

      expect(registry.peekResolved('lazy')).toBeUndefined();
      expect(constructed).toBe(0);
      // The peek does not poison a later real resolution.
      expect(registry.get('lazy')).toEqual({ built: true });
    });

    it('falls through to the parent for a token absent locally', () => {
      const parent = new ServiceRegistry();
      const instance = { from: 'parent' };
      parent.register('shared', instance);
      const child = parent.createChild();

      expect(child.peekResolved<{ from: string }>('shared')).toBe(instance);
      // A token on neither registry answers undefined.
      expect(child.peekResolved('absent')).toBeUndefined();
    });

    it('never falls past an unresolved LOCAL registration to the parent', () => {
      const parent = new ServiceRegistry();
      parent.register('shared', { from: 'parent' });
      const child = parent.createChild();
      child.registerFactory('shared', () => ({ from: 'child' }));

      // The local factory is unresolved: "present but never constructed" is
      // the answer, not the parent's instance.
      expect(child.peekResolved('shared')).toBeUndefined();
      expect(child.get('shared')).toEqual({ from: 'child' });
    });

    it('uses the single-registration lookup precedence over multi-providers', () => {
      const registry = new ServiceRegistry();
      const single = { single: true };
      registry.register('svc', single);
      registry.register('svc', { multi: true }, { multi: true });

      expect(registry.peekResolved('svc')).toBe(single);
    });

    it('peeks the first multi-provider without enumerating the rest', () => {
      const registry = new ServiceRegistry();
      const first = { first: true };
      registry.register('svc', first, { multi: true });
      registry.register('svc', { second: true }, { multi: true });

      expect(registry.peekResolved('svc')).toBe(first);
    });
  });

  describe('diagnostics sink', () => {
    it('reports successful registrations and removals, never refused ones', () => {
      const registry = new ServiceRegistry();
      const events: { kind: string; token: string }[] = [];
      registry.setDiagnosticsSink((event) => events.push(event));

      registry.register('svc', {});
      registry.registerFactory('lazy', () => ({}));
      registry.register('multi', {}, { multi: true });
      expect(events).toEqual([
        { kind: 'register-single', token: 'svc' },
        { kind: 'register-single', token: 'lazy' },
        { kind: 'register-multi', token: 'multi' },
      ]);

      events.length = 0;
      expect(registry.unregister('svc')).toBe(true);
      expect(events).toEqual([{ kind: 'unregister', token: 'svc' }]);
      // A removal that removed nothing reports nothing.
      registry.unregister('absent');
      expect(events.length).toBe(1);

      // A refused duplicate throws and produces NO event.
      events.length = 0;
      expect(() => registry.register('lazy', {})).toThrow(/already registered/);
      expect(events).toEqual([]);
    });

    it('detaches when the sink is set to undefined', () => {
      const registry = new ServiceRegistry();
      const events: unknown[] = [];
      registry.setDiagnosticsSink((event) => events.push(event));
      registry.setDiagnosticsSink(undefined);
      registry.register('svc', {});
      expect(events).toEqual([]);
    });
  });
});

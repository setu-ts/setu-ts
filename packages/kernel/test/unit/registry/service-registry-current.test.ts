import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ServiceRegistry } from '../../../src/registry/service-registry.ts';

describe('ServiceRegistry.isCurrent (M98h)', () => {
  it('reports true for the exact registered instance', () => {
    const registry = new ServiceRegistry();
    const instance = { value: 1 };
    registry.register('token', instance);
    expect(registry.isCurrent('token', instance)).toBe(true);
  });

  it('reports false for a different instance of the same shape', () => {
    const registry = new ServiceRegistry();
    const instance = { value: 1 };
    registry.register('token', instance);
    expect(registry.isCurrent('token', { value: 1 })).toBe(false);
  });

  it('reports false for an unregistered token', () => {
    const registry = new ServiceRegistry();
    const instance = { value: 1 };
    expect(registry.isCurrent('missing', instance)).toBe(false);
  });

  it('reports true for the first multi-provider and false for the rest', () => {
    const registry = new ServiceRegistry();
    const first = { value: 1 };
    const second = { value: 2 };
    registry.register('multi', first, { multi: true });
    registry.register('multi', second, { multi: true });
    // The same precedence as get: the first registered multi-provider.
    expect(registry.isCurrent('multi', first)).toBe(true);
    expect(registry.isCurrent('multi', second)).toBe(false);
  });

  it('prefers the own single registration over the parent', () => {
    const parent = new ServiceRegistry();
    const parentInstance = { value: 'parent' };
    parent.register('token', parentInstance);
    const child = parent.createChild();
    const childInstance = { value: 'child' };
    child.register('token', childInstance);
    expect(child.isCurrent('token', childInstance)).toBe(true);
    expect(child.isCurrent('token', parentInstance)).toBe(false);
    // The parent still sees its own registration.
    expect(parent.isCurrent('token', parentInstance)).toBe(true);
  });

  it('falls through to the parent when the child has no own registration', () => {
    const parent = new ServiceRegistry();
    const parentInstance = { value: 'parent' };
    parent.register('token', parentInstance);
    const child = parent.createChild();
    expect(child.isCurrent('token', parentInstance)).toBe(true);
    expect(child.isCurrent('token', { value: 'other' })).toBe(false);
  });

  it('never invokes a lazy factory and answers false for an unresolved registration', () => {
    const registry = new ServiceRegistry();
    let constructed = 0;
    registry.registerFactory('lazy', () => {
      constructed += 1;
      return { value: 'constructed' };
    });
    // The registration exists but has never been constructed.
    expect(registry.isCurrent('lazy', { value: 'constructed' })).toBe(false);
    expect(registry.isCurrent('lazy', {})).toBe(false);
    expect(constructed).toBe(0);
  });

  it('does not fall past an unresolved local registration to a parent instance', () => {
    const parent = new ServiceRegistry();
    const parentInstance = { value: 'parent' };
    parent.register('token', parentInstance);
    const child = parent.createChild();
    let constructed = 0;
    child.registerFactory('token', () => {
      constructed += 1;
      return { value: 'child' };
    });
    // The child has a local registration (unresolved), so the parent's
    // instance is not the current one — and the factory was not run.
    expect(child.isCurrent('token', parentInstance)).toBe(false);
    expect(constructed).toBe(0);
  });

  it('answers true for the instance a factory resolved to', () => {
    const registry = new ServiceRegistry();
    registry.registerFactory('lazy', () => ({ value: 1 }));
    const constructed = registry.get('lazy');
    expect(registry.isCurrent('lazy', constructed)).toBe(true);
    expect(registry.isCurrent('lazy', { value: 1 })).toBe(false);
  });

  it('answers false after an override replaced the instance', () => {
    const registry = new ServiceRegistry();
    const original = { value: 1 };
    const replacement = { value: 2 };
    registry.register('token', original);
    registry.register('token', replacement, { override: true });
    expect(registry.isCurrent('token', original)).toBe(false);
    expect(registry.isCurrent('token', replacement)).toBe(true);
  });
});

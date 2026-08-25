import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ServiceRegistry } from '../../../src/registry/service-registry.ts';

describe('ServiceRegistry sealing', () => {
  it('refuses every mutation after sealing while retaining reads', () => {
    const registry = new ServiceRegistry();
    registry.register('existing', { value: true });
    registry.seal();
    expect(registry.get('existing')).toEqual({ value: true });
    expect(registry.has('existing')).toBe(true);
    expect(() => registry.register('new', {})).toThrow('onBootstrap');
    expect(() => registry.registerFactory('factory', () => ({}))).toThrow('onBootstrap');
    expect(() => registry.unregister('existing')).toThrow('onBootstrap');
    registry.seal();
  });

  it('leaves children unsealed and does not inherit an observer', () => {
    const events: string[] = [];
    const registry = new ServiceRegistry();
    registry.setObserver((kind, token) => events.push(`${kind}:${token}`));
    registry.seal();
    const child = registry.createChild();
    child.register('child', { value: true });
    child.register('child', { value: false }, { override: true });
    expect(child.get('child')).toEqual({ value: false });
    expect(events).toEqual([]);
  });

  it('observes only overrides and real unregisters', () => {
    const events: string[] = [];
    const registry = new ServiceRegistry();
    registry.setObserver((kind, token) => events.push(`${kind}:${token}`));
    registry.register('first', {});
    registry.register('multi', {}, { multi: true });
    registry.register('first', {}, { override: true });
    expect(registry.unregister('missing')).toBe(false);
    expect(registry.unregister('first')).toBe(true);
    expect(events).toEqual(['override:first', 'unregister:first']);
  });
});

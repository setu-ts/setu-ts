import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { MockServiceRegistry } from '../../src/mock-registry.ts';

describe('createMockPlugin', () => {
  it('returns an IPlugin with correct name and default provides', () => {
    const svc = { query: () => [] };
    const plugin = createMockPlugin({ name: 'database', service: svc });

    expect(plugin.name).toBe('database');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual(['database']);
  });

  it('register() calls services.register with the right token and service', () => {
    const svc = { query: () => [] };
    const plugin = createMockPlugin({ name: 'database', service: svc });
    const registry = new MockServiceRegistry();
    const ctx = { services: registry } as unknown as Parameters<typeof plugin.register>[0];

    plugin.register(ctx);

    expect(registry.has('database')).toBe(true);
    expect(registry.get('database')).toBe(svc);
  });

  it('provides option overrides the token when plugin name differs', () => {
    const svc = { query: () => [] };
    const plugin = createMockPlugin({
      name: 'db-mock',
      service: svc,
      provides: 'database',
    });

    expect(plugin.provides).toEqual(['database']);

    const registry = new MockServiceRegistry();
    const ctx = { services: registry } as unknown as Parameters<typeof plugin.register>[0];
    plugin.register(ctx);

    expect(registry.has('database')).toBe(true);
    expect(registry.get('database')).toBe(svc);
    expect(registry.has('db-mock')).toBe(false);
  });

  it('the register callback runs after the service registration', () => {
    let callbackRan = false;
    const svc = { query: () => [] };
    const plugin = createMockPlugin({
      name: 'database',
      service: svc,
      register(_ctx) {
        callbackRan = true;
      },
    });

    const registry = new MockServiceRegistry();
    const ctx = { services: registry } as unknown as Parameters<typeof plugin.register>[0];
    plugin.register(ctx);

    expect(callbackRan).toBe(true);
  });

  it('priority is included when provided', () => {
    const plugin = createMockPlugin({
      name: 'test',
      service: {},
      priority: 10,
    });
    expect(plugin.priority).toBe(10);
  });

  it('priority is omitted when not provided', () => {
    const plugin = createMockPlugin({
      name: 'test',
      service: {},
    });
    expect('priority' in plugin).toBe(false);
  });
});

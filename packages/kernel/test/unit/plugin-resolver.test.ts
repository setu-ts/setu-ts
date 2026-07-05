import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPlugin } from '@hono-enterprise/common';
import { resolvePluginOrder } from '../../src/registry/plugin-resolver.ts';

function plugin(
  name: string,
  options: {
    dependencies?: string[];
    optionalDependencies?: string[];
    provides?: string[];
    priority?: number;
  } = {},
): IPlugin {
  return {
    name,
    version: '1.0.0',
    ...(options.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
    ...(options.optionalDependencies !== undefined
      ? { optionalDependencies: options.optionalDependencies }
      : {}),
    ...(options.provides !== undefined ? { provides: options.provides } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    register: () => {},
  } as IPlugin;
}

describe('resolvePluginOrder', () => {
  it('should place runtime provider first', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const other = plugin('other');
    const ordered = resolvePluginOrder([other, runtime]);
    expect(ordered[0].name).toBe('runtime');
    expect(ordered[1].name).toBe('other');
  });

  it('should resolve dependency order', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { dependencies: ['b'] });
    const b = plugin('b');
    const ordered = resolvePluginOrder([runtime, a, b]);
    const names = ordered.map((p) => p.name);
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('a'));
  });

  it('should break priority ties with lower priority first', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { priority: 100 });
    const b = plugin('b', { priority: 200 });
    const ordered = resolvePluginOrder([runtime, b, a]);
    expect(ordered[1].name).toBe('a');
    expect(ordered[2].name).toBe('b');
  });

  it('should break priority ties with insertion order', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { priority: 500 });
    const b = plugin('b', { priority: 500 });
    const ordered = resolvePluginOrder([runtime, a, b]);
    expect(ordered[1].name).toBe('a');
    expect(ordered[2].name).toBe('b');
  });

  it('should throw on missing runtime provider', () => {
    const a = plugin('a');
    expect(() => resolvePluginOrder([a])).toThrow("mandatory 'runtime' capability");
  });

  it('should throw on circular dependency', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { dependencies: ['b'] });
    const b = plugin('b', { dependencies: ['a'] });
    expect(() => resolvePluginOrder([runtime, a, b])).toThrow(/Circular.*a.*->.*b.*->.*a/);
  });

  it('should throw on missing dependency', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { dependencies: ['missing'] });
    expect(() => resolvePluginOrder([runtime, a])).toThrow(
      "depends on capability 'missing'",
    );
  });

  it('should throw on duplicate plugin names', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('dup');
    const b = plugin('dup');
    expect(() => resolvePluginOrder([runtime, a, b])).toThrow(
      "Duplicate plugin name 'dup'",
    );
  });

  it('should allow optional dependencies when absent', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { optionalDependencies: ['missing'] });
    const ordered = resolvePluginOrder([runtime, a]);
    expect(ordered.length).toBe(2);
  });

  it('should include optional dependency when present', () => {
    const runtime = plugin('runtime', { provides: [CAPABILITIES.RUNTIME] });
    const a = plugin('a', { optionalDependencies: ['b'] });
    const b = plugin('b');
    const ordered = resolvePluginOrder([runtime, a, b]);
    const names = ordered.map((p) => p.name);
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('a'));
  });

  it('should throw on duplicate capability providers', () => {
    const a = plugin('a', { provides: ['shared'] });
    const b = plugin('b', { provides: ['shared'] });
    expect(() => resolvePluginOrder([a, b])).toThrow(
      "Capability 'shared' is provided by both",
    );
  });
});

/**
 * Parsing the registry options (M127 §3.2, §3.5, §3.7): the three `tenants`
 * shapes, `unknownTenantStatus` and `tenantCache` refusals.
 */
import { describe, expect, it } from 'vitest';
import type { ITenantRegistry } from '@setu-ts/common';
import { none } from '@setu-ts/common';
import type { MultiTenancyPluginOptions } from '../../src/interfaces/index.ts';
import {
  assertUsableRegistry,
  DEFAULT_UNKNOWN_TENANT_STATUS,
  parseRegistryOptions,
} from '../../src/registry/registry-options.ts';
import { StaticTenantRegistry } from '../../src/registry/static-tenant-registry.ts';

const registry: ITenantRegistry = { lookup: () => Promise.resolve(none()) };

function parse(extra: Partial<MultiTenancyPluginOptions>) {
  return parseRegistryOptions({ resolver: 'header', ...extra });
}

describe('parseRegistryOptions', () => {
  it('omitted tenants → no registry, default status', () => {
    expect(parse({})).toEqual({
      registry: { kind: 'none' },
      unknownTenantStatus: DEFAULT_UNKNOWN_TENANT_STATUS,
    });
    expect(DEFAULT_UNKNOWN_TENANT_STATUS).toBe(404);
  });

  it('an array → a static registry, never cached', () => {
    const parsed = parse({ tenants: ['acme'] });
    expect(parsed.registry.kind).toBe('static');
    expect(parsed.registry.kind === 'static' && parsed.registry.registry).toBeInstanceOf(
      StaticTenantRegistry,
    );
  });

  it('an instance → custom, cached with the defaults', () => {
    const parsed = parse({ tenants: registry });
    expect(parsed.registry).toEqual({
      kind: 'custom',
      registry,
      cache: { ttlMs: 30_000, maxEntries: 1_000, maxBytes: 1_048_576 },
    });
  });

  it('a function → a factory, with the configured cache', () => {
    const factory = () => registry;
    const parsed = parse({
      tenants: factory,
      tenantCache: { ttlMs: 5, maxEntries: 2, maxBytes: 9 },
    });
    expect(parsed.registry).toEqual({
      kind: 'factory',
      factory,
      cache: { ttlMs: 5, maxEntries: 2, maxBytes: 9 },
    });
  });

  it('tenantCache: false and ttlMs: 0 both disable the cache', () => {
    const off = parse({ tenants: registry, tenantCache: false });
    expect(off.registry.kind === 'custom' && off.registry.cache).toBeUndefined();
    const zero = parse({ tenants: registry, tenantCache: { ttlMs: 0 } });
    expect(zero.registry.kind === 'custom' && zero.registry.cache).toBeUndefined();
  });

  it('an instance without lookup is refused, naming the option', () => {
    expect(() => parse({ tenants: {} as never })).toThrow(
      'MultiTenancyPlugin.tenants: the instance is not an ITenantRegistry',
    );
    expect(() => parse({ tenants: { lookup: 'no' } as never })).toThrow(/not an ITenantRegistry/);
  });

  it('assertUsableRegistry refuses non-objects and accepts a registry', () => {
    expect(() => assertUsableRegistry(null, 'x')).toThrow(/x is not an ITenantRegistry/);
    expect(() => assertUsableRegistry('str', 'x')).toThrow(/not an ITenantRegistry/);
    expect(() => assertUsableRegistry(registry, 'x')).not.toThrow();
  });

  it.each([399, 500, 200, Number.NaN, 404.5, Number.POSITIVE_INFINITY, '404' as never])(
    'unknownTenantStatus %s is refused',
    (status) => {
      expect(() => parse({ tenants: ['a'], unknownTenantStatus: status })).toThrow(
        'unknownTenantStatus must be an integer in 400-499',
      );
    },
  );

  it.each([400, 403, 404, 499])('unknownTenantStatus %s is accepted', (status) => {
    expect(parse({ tenants: ['a'], unknownTenantStatus: status }).unknownTenantStatus).toBe(status);
  });

  it('unknownTenantStatus or tenantCache without tenants is refused', () => {
    expect(() => parse({ unknownTenantStatus: 403 })).toThrow(
      /unknownTenantStatus is set but `tenants` is not/,
    );
    expect(() => parse({ tenantCache: { ttlMs: 1 } })).toThrow(
      /tenantCache is set but `tenants` is not/,
    );
    expect(() => parse({ tenantCache: false })).toThrow(/tenantCache is set but `tenants` is not/);
  });

  it('tenantCache with a tenants list is refused', () => {
    expect(() => parse({ tenants: ['a'], tenantCache: { ttlMs: 1 } })).toThrow(
      /tenantCache does not apply to a `tenants` list/,
    );
  });

  it('a non-object tenantCache is refused', () => {
    expect(() => parse({ tenants: registry, tenantCache: true as never })).toThrow(
      /tenantCache must be false or an options object/,
    );
    expect(() => parse({ tenants: registry, tenantCache: null as never })).toThrow(
      /tenantCache must be false or an options object/,
    );
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['ttlMs NaN', { ttlMs: Number.NaN }, /tenantCache.ttlMs must be a finite integer >= 0/],
    ['ttlMs Infinity', { ttlMs: Infinity }, /tenantCache.ttlMs/],
    ['ttlMs -1', { ttlMs: -1 }, /tenantCache.ttlMs/],
    ['ttlMs 1.5', { ttlMs: 1.5 }, /tenantCache.ttlMs/],
    ['maxEntries 0', { maxEntries: 0 }, /tenantCache.maxEntries must be a finite integer >= 1/],
    ['maxEntries NaN', { maxEntries: Number.NaN }, /tenantCache.maxEntries/],
    ['maxEntries -1', { maxEntries: -1 }, /tenantCache.maxEntries/],
    [
      'maxBytes Infinity',
      { maxBytes: Infinity },
      /tenantCache.maxBytes must be a finite integer >= 1/,
    ],
    ['maxBytes 0', { maxBytes: 0 }, /tenantCache.maxBytes/],
    ['maxBytes string', { maxBytes: '9' }, /tenantCache.maxBytes/],
  ])('refuses tenantCache %s by name', (_label, cache, message) => {
    expect(() => parse({ tenants: registry, tenantCache: cache as never })).toThrow(message);
  });
});

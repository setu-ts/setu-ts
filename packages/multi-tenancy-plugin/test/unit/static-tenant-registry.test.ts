/**
 * The static tenant registry (M127 §3.2) — what a `tenants` array becomes.
 */
import { describe, expect, it } from 'vitest';
import type { ITenant } from '@setu-ts/common';
import { freezeTenant, StaticTenantRegistry } from '../../src/registry/static-tenant-registry.ts';

describe('StaticTenantRegistry', () => {
  it('a hit returns a frozen copy whose top-level metadata is frozen too', async () => {
    const metadata = { plan: 'gold', nested: { seats: 3 } };
    const source: ITenant = { id: 'acme', name: 'Acme', metadata };
    const registry = new StaticTenantRegistry([source, 'globex']);

    const hit = await registry.lookup('acme');
    expect(hit.present).toBe(true);
    const tenant = hit.present ? hit.value : undefined;
    expect(tenant).toEqual({ id: 'acme', name: 'Acme', metadata });
    expect(tenant).not.toBe(source);
    expect(Object.isFrozen(tenant)).toBe(true);
    expect(Object.isFrozen(tenant?.metadata)).toBe(true);
    expect(tenant?.metadata).not.toBe(metadata);
    // Deeper objects stay the application's (documented).
    expect(Object.isFrozen(metadata.nested)).toBe(false);

    // Mutating the source after construction does not reach the registry.
    (source as { name: string }).name = 'Changed';
    const again = await registry.lookup('acme');
    expect(again.present && again.value.name).toBe('Acme');

    const plain = await registry.lookup('globex');
    expect(plain.present && plain.value).toEqual({ id: 'globex' });
    expect(Object.isFrozen(plain.present && plain.value)).toBe(true);
  });

  it('a miss is none()', async () => {
    const registry = new StaticTenantRegistry(['acme']);
    expect((await registry.lookup('initech')).present).toBe(false);
    expect((await registry.lookup('ACME')).present).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'hasOwnProperty', 'toString'])(
    'the prototype-named id %s is a miss unless listed',
    async (id) => {
      expect((await new StaticTenantRegistry(['acme']).lookup(id)).present).toBe(false);
      const listed = await new StaticTenantRegistry([id]).lookup(id);
      expect(listed.present && listed.value.id).toBe(id);
    },
  );

  it.each<[string, readonly unknown[], RegExp]>([
    ['an empty list', [], /`tenants` option is an empty list/],
    ['an empty id', [''], /entry 0 has an empty id/],
    ['a whitespace id', ['  '], /entry 0 has leading or trailing whitespace/],
    ['an untrimmed id', ['ok', ' acme'], /entry 1 has leading or trailing whitespace/],
    ['an over-long id', ['x'.repeat(257)], /entry 0 is longer than 256/],
    ['a non-string id', [42], /entry 0 has a non-string id/],
    ['a non-string object id', [{ id: 7 }], /entry 0 has a non-string id/],
    ['a null entry', [null], /entry 0 has a non-string id/],
    ['a duplicate id', ['acme', { id: 'acme' }], /lists the id at entry 1 more than once/],
  ])('refuses %s, naming the option', (_label, entries, message) => {
    expect(() => new StaticTenantRegistry(entries as readonly (string | ITenant)[])).toThrow(
      message,
    );
    expect(() => new StaticTenantRegistry(entries as readonly (string | ITenant)[])).toThrow(
      /MultiTenancyPlugin: the `tenants` option/,
    );
  });

  it('accepts a 256-character id (the bound is inclusive)', async () => {
    const id = 'a'.repeat(256);
    expect((await new StaticTenantRegistry([id]).lookup(id)).present).toBe(true);
  });

  it('freezeTenant omits absent name and metadata', () => {
    expect(Object.keys(freezeTenant({ id: 'x' }))).toEqual(['id']);
  });
});

/**
 * `createDatabaseTenantRegistry` (M127 §3.8) over a REAL `DatabaseService` and
 * `MemoryAdapter`: hit, miss, inactive, malformed id, `nameField`,
 * `toMetadata`, row columns absent from the tenant, option refusals.
 */
import { describe, expect, it } from 'vitest';
import type { IServiceRegistry, ITenantRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseTenantRegistry,
  type DatabaseTenantRegistryOptions,
  DatabaseService,
  MemoryAdapter,
} from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

async function setup(
  rows: readonly Record<string, unknown>[],
  options?: DatabaseTenantRegistryOptions,
  entity = 'Tenant',
): Promise<{ registry: ITenantRegistry; resolved: string[] }> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const service = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'memory');
  const repo = service.getRepository<Record<string, unknown>>(entity);
  for (const row of rows) await repo.create(row);
  const resolved: string[] = [];
  const services = {
    get: (token: string) => {
      resolved.push(token);
      return service as IDatabaseService;
    },
  } as unknown as IServiceRegistry;
  return { registry: createDatabaseTenantRegistry(options)(services), resolved };
}

describe('createDatabaseTenantRegistry — memory adapter', () => {
  it('resolves CAPABILITIES.DATABASE and answers a hit with id and name only', async () => {
    const { registry, resolved } = await setup([
      { id: 'acme', name: 'Acme', apiKey: 'sk-secret', plan: 'gold' },
    ]);
    expect(resolved).toEqual([CAPABILITIES.DATABASE]);
    const hit = await registry.lookup('acme');
    expect(hit.present && hit.value).toEqual({ id: 'acme', name: 'Acme' });
    // O7: no key beyond id/name/metadata, though a secret column is on the row.
    expect(Object.keys(hit.present ? hit.value : {})).toEqual(['id', 'name']);
    expect(JSON.stringify(hit)).not.toContain('sk-secret');
  });

  it('a miss is none()', async () => {
    const { registry } = await setup([{ id: 'acme', name: 'Acme' }]);
    expect((await registry.lookup('initech')).present).toBe(false);
  });

  it('an inactive row is none(); an active one is a hit', async () => {
    const { registry } = await setup(
      [
        { id: 'acme', name: 'Acme', active: true },
        { id: 'globex', name: 'Globex', active: false },
        { id: 'umbrella', name: 'Umbrella' },
      ],
      { activeField: 'active' },
    );
    expect((await registry.lookup('acme')).present).toBe(true);
    expect((await registry.lookup('globex')).present).toBe(false);
    expect((await registry.lookup('umbrella')).present).toBe(false);
  });

  it('matches on idField (a slug) and returns its value as the canonical id', async () => {
    const { registry } = await setup([{ id: 'row-1', slug: 'acme', title: 'Acme Inc' }], {
      idField: 'slug',
      nameField: 'title',
    });
    const hit = await registry.lookup('acme');
    expect(hit.present && hit.value).toEqual({ id: 'acme', name: 'Acme Inc' });
  });

  it('a non-string name is omitted', async () => {
    const { registry } = await setup([{ id: 'acme', name: 42 }]);
    const hit = await registry.lookup('acme');
    expect(hit.present && hit.value).toEqual({ id: 'acme' });
  });

  it('toMetadata builds metadata from the row', async () => {
    const { registry } = await setup([{ id: 'acme', name: 'Acme', plan: 'gold', apiKey: 'x' }], {
      toMetadata: (row) => ({ plan: row.plan }),
    });
    const hit = await registry.lookup('acme');
    expect(hit.present && hit.value).toEqual({
      id: 'acme',
      name: 'Acme',
      metadata: { plan: 'gold' },
    });
  });

  it('a row whose idField is not a non-empty string throws a TypeError naming entity and field', async () => {
    const { registry } = await setup(
      [{ id: 'row-1', code: '' }],
      { idField: 'code', entity: 'Org' },
      'Org',
    );
    const error = await registry.lookup('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "createDatabaseTenantRegistry: the 'Org' row's 'code' is not a non-empty string.",
    );
  });

  it('a non-string idField value on a matched row throws (a repository matching loosely)', async () => {
    const services = {
      get: () => ({
        getRepository: () => ({ findOne: () => Promise.resolve({ id: 7 }) }),
      }),
    } as unknown as IServiceRegistry;
    await expect(createDatabaseTenantRegistry()(services).lookup('7')).rejects.toThrow(
      "the 'Tenant' row's 'id' is not a non-empty string",
    );
  });

  it.each<[string, DatabaseTenantRegistryOptions | null, RegExp]>([
    ['entity ""', { entity: '' }, /entity must be a non-empty string/],
    ['idField 3', { idField: 3 as never }, /idField must be a non-empty string/],
    ['nameField ""', { nameField: '' }, /nameField must be a non-empty string/],
    ['activeField ""', { activeField: '' }, /activeField must be a non-empty string/],
    ['toMetadata "x"', { toMetadata: 'x' as never }, /toMetadata must be a function/],
    ['options null', null, /options must be an object/],
  ])('refuses %s when the factory is created', (_label, options, message) => {
    expect(() => createDatabaseTenantRegistry(options as never)).toThrow(TypeError);
    expect(() => createDatabaseTenantRegistry(options as never)).toThrow(message);
  });

  it('the factory fetches the repository once', async () => {
    let repositories = 0;
    const services = {
      get: () => ({
        getRepository: () => {
          repositories++;
          return { findOne: () => Promise.resolve(null) };
        },
      }),
    } as unknown as IServiceRegistry;
    const registry = createDatabaseTenantRegistry()(services);
    await registry.lookup('a');
    await registry.lookup('b');
    expect(repositories).toBe(1);
  });
});

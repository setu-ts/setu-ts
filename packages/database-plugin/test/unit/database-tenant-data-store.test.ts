/**
 * The tenant data-store bridge over a recording fake `IDatabaseService`
 * (M101c, V8-8): every method's translated `IRepository` call, the tenant
 * column spread/stamped LAST, strip-on-update, the strategy table, and the
 * factory's `CAPABILITIES.DATABASE` resolution.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import type { IDatabaseService, IRepository } from '../../src/interfaces/index.ts';
import {
  createDatabaseTenantDataStore,
  DatabaseTenantDataStore,
  TenantStoreStrategyUnsupportedError,
} from '../../src/tenancy/database-tenant-data-store.ts';

/** One recorded repository call: the method and its argument. */
interface RecordedCall {
  readonly method: string;
  readonly arg: unknown;
}

/** A recording `IRepository` over a fixed row set. */
class FakeRepository implements IRepository<Record<string, unknown>, EntityKey> {
  readonly calls: RecordedCall[] = [];
  /** Rows the `findOne` lookups return, keyed by `where.id`. */
  readonly rows = new Map<string, Record<string, unknown>>();

  constructor(private readonly out: Record<string, unknown>[]) {
    for (const row of this.out) {
      this.rows.set(String(row.id), row);
    }
  }

  // deno-lint-ignore require-await
  async findAll(options?: { where?: Record<string, unknown> }): Promise<Record<string, unknown>[]> {
    this.calls.push({ method: 'findAll', arg: options });
    return this.out;
  }

  // deno-lint-ignore require-await
  async findOne(
    options?: { where?: Record<string, unknown> },
  ): Promise<Record<string, unknown> | null> {
    this.calls.push({ method: 'findOne', arg: options });
    const where = options?.where;
    if (where === undefined) return null;
    // Honor the FULL conjoin (id AND tenant column), not just the id: a foreign
    // tenant's id must not resolve to a row.
    for (const row of this.rows.values()) {
      if (Object.entries(where).every(([key, value]) => row[key] === value)) {
        return row;
      }
    }
    return null;
  }

  // deno-lint-ignore require-await
  async create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
    this.calls.push({ method: 'create', arg: data });
    return { id: 'new', ...data };
  }

  // deno-lint-ignore require-await
  async update(
    id: EntityKey,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method: 'update', arg: { id, data } });
    return { ...this.rows.get(String(id)), ...data };
  }

  // deno-lint-ignore require-await
  async delete(id: EntityKey): Promise<boolean> {
    this.calls.push({ method: 'delete', arg: { id } });
    return this.rows.delete(String(id));
  }

  // deno-lint-ignore require-await
  async findById(id: EntityKey): Promise<Record<string, unknown> | null> {
    return this.rows.get(String(id)) ?? null;
  }

  // deno-lint-ignore require-await
  async exists(id: EntityKey): Promise<boolean> {
    return this.rows.has(String(id));
  }

  // deno-lint-ignore require-await
  async count(): Promise<number> {
    return this.out.length;
  }

  // deno-lint-ignore require-await
  async findPage(): Promise<never> {
    throw new Error('not used');
  }
}

/** A recording `IDatabaseService` handing out one repository per entity. */
class FakeDatabaseService implements IDatabaseService {
  readonly repos = new Map<string, FakeRepository>();
  readonly service = this;

  getRepository<Entity, Id extends EntityKey = string>(
    entity: string,
  ): IRepository<Entity, Id> {
    let repo = this.repos.get(entity);
    if (repo === undefined) {
      repo = new FakeRepository([]);
      this.repos.set(entity, repo);
    }
    return repo as unknown as IRepository<Entity, Id>;
  }

  // deno-lint-ignore require-await
  async transaction(): Promise<never> {
    throw new Error('not used');
  }

  // deno-lint-ignore require-await
  async query(): Promise<never[]> {
    throw new Error('not used');
  }

  // deno-lint-ignore require-await
  async migrate(): Promise<void> {
    throw new Error('not used');
  }

  // deno-lint-ignore require-await
  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

const ROWS = [
  { id: '1', name: 'alpha', tenant_id: 'a' },
  { id: '2', name: 'beta', tenant_id: 'b' },
];

function storeWith(rows: Record<string, unknown>[] = ROWS, tenantColumn?: string): {
  store: DatabaseTenantDataStore;
  service: FakeDatabaseService;
  repo: () => FakeRepository;
} {
  const service = new FakeDatabaseService();
  service.repos.set('Patient', new FakeRepository(rows));
  const store = new DatabaseTenantDataStore(service, tenantColumn);
  return { store, service, repo: () => service.repos.get('Patient')! };
}

describe('DatabaseTenantDataStore (M101c, V8-8)', () => {
  it('findAll conjoins the tenant column to where', async () => {
    const { store, repo } = storeWith();
    await store.findAll('a', 'Patient');
    const [call] = repo().calls;
    expect(call.method).toBe('findAll');
    expect(call.arg).toEqual({ where: { tenant_id: 'a' } });
  });

  it('findById looks one up under the tenant', async () => {
    const { store, repo } = storeWith();
    const row = await store.findById('a', 'Patient', '1');
    const [call] = repo().calls;
    expect(call.method).toBe('findOne');
    expect(call.arg).toEqual({ where: { id: '1', tenant_id: 'a' } });
    expect(row).toEqual(ROWS[0]);
  });

  it('findById returns null when the id is unknown under the tenant', async () => {
    const { store } = storeWith();
    expect(await store.findById('a', 'Patient', '99')).toBeNull();
  });

  it('find spreads the tenant column LAST so a caller filter cannot override it', async () => {
    const { store, repo } = storeWith();
    // A malicious filter naming the tenant column is overridden by the
    // store's own stamp, which is spread after it.
    await store.find('b', 'Patient', { tenant_id: 'a', name: 'alpha' });
    const [call] = repo().calls;
    expect(call.method).toBe('findAll');
    expect(call.arg).toEqual({ where: { name: 'alpha', tenant_id: 'b' } });
  });

  it('create stamps the tenant column LAST so a caller payload cannot override it', async () => {
    const { store, repo } = storeWith();
    await store.create('a', 'Patient', { name: 'alpha', tenant_id: 'b' });
    const [call] = repo().calls;
    expect(call.method).toBe('create');
    expect(call.arg).toEqual({ name: 'alpha', tenant_id: 'a' });
  });

  it('update looks the row up under the tenant first and strips the column from the payload', async () => {
    const { store, repo } = storeWith();
    const updated = await store.update('a', 'Patient', '1', { name: 'renamed', tenant_id: 'b' });
    const [lookup, write] = repo().calls;
    expect(lookup.method).toBe('findOne');
    expect(lookup.arg).toEqual({ where: { id: '1', tenant_id: 'a' } });
    expect(write.method).toBe('update');
    expect(write.arg).toEqual({ id: '1', data: { name: 'renamed' } });
    expect(updated).toMatchObject({ id: '1', name: 'renamed' });
  });

  it('update returns null when the id is unknown under the tenant (no write)', async () => {
    const { store, repo } = storeWith();
    expect(await store.update('a', 'Patient', '2', { name: 'x' })).toBeNull();
    expect(repo().calls.map((c) => c.method)).toEqual(['findOne']);
  });

  it('delete looks the row up under the tenant first and returns false when absent', async () => {
    const { store, repo } = storeWith();
    expect(await store.delete('a', 'Patient', '2')).toBe(false);
    expect(repo().calls.map((c) => c.method)).toEqual(['findOne']);
  });

  it('delete removes the row when it exists under the tenant', async () => {
    const { store, repo } = storeWith();
    expect(await store.delete('a', 'Patient', '1')).toBe(true);
    expect(repo().calls.map((c) => c.method)).toEqual(['findOne', 'delete']);
  });

  it('a custom tenantColumn is used for the stamp and the conjoin', async () => {
    const { store, repo } = storeWith(ROWS, 'org_id');
    await store.findAll('a', 'Patient');
    expect(repo().calls[0].arg).toEqual({ where: { org_id: 'a' } });
  });
});

describe('DatabaseTenantDataStore.useIsolation — the strategy table (M101c, §3.4)', () => {
  // A table the test iterates rather than prose: a fourth kind forces a
  // decision instead of drifting silently (the M90h secrets-table rule).
  const TABLE = [
    {
      kind: 'column',
      strategy: { kind: 'column' as const, getTenantColumn: () => 'tenant_id' },
      expected: 'adopts',
    },
    {
      kind: 'schema',
      strategy: { kind: 'schema' as const, resolveSchema: (t: string) => `s_${t}` },
      expected: 'throws',
    },
    {
      kind: 'database',
      strategy: { kind: 'database' as const, resolveDatabase: (t: string) => `db_${t}` },
      expected: 'throws',
    },
  ] as const;

  for (const row of TABLE) {
    it(`kind '${row.kind}' → ${row.expected}`, () => {
      const { store } = storeWith();
      if (row.expected === 'adopts') {
        expect(() => store.useIsolation(row.strategy)).not.toThrow();
        // The adopted column is used for the conjoin.
        return;
      }
      expect(() => store.useIsolation(row.strategy)).toThrow(TenantStoreStrategyUnsupportedError);
    });
  }

  it('a column strategy naming a different column than tenantColumn throws naming both', () => {
    const { store } = storeWith(ROWS, 'org_id');
    expect(() => store.useIsolation({ kind: 'column', getTenantColumn: () => 'tenant_id' }))
      .toThrow(/org_id.*tenant_id|tenant_id.*org_id/);
  });

  it('a column strategy agreeing with tenantColumn adopts cleanly', () => {
    const { store } = storeWith(ROWS, 'tenant_id');
    expect(() => store.useIsolation({ kind: 'column', getTenantColumn: () => 'tenant_id' })).not
      .toThrow();
  });
});

describe('createDatabaseTenantDataStore (M101c, V8-8)', () => {
  it('returns a factory that resolves CAPABILITIES.DATABASE from the registry it is handed', () => {
    const service = new FakeDatabaseService();
    const services: IServiceRegistry = {
      get: (token: string) => {
        expect(token).toBe(CAPABILITIES.DATABASE);
        return service;
      },
      register: () => {},
      registerFactory: () => {},
      getAll: () => [],
      has: () => true,
    } as unknown as IServiceRegistry;

    const store = createDatabaseTenantDataStore()(services);
    expect(store).toBeInstanceOf(DatabaseTenantDataStore);
  });

  it('passes tenantColumn through to the store', async () => {
    const service = new FakeDatabaseService();
    service.repos.set('Patient', new FakeRepository(ROWS));
    const services = { get: () => service } as unknown as IServiceRegistry;
    const store = createDatabaseTenantDataStore({ tenantColumn: 'org_id' })(services);
    await store.findAll('a', 'Patient');
    expect(service.repos.get('Patient')!.calls[0].arg).toEqual({ where: { org_id: 'a' } });
  });
});

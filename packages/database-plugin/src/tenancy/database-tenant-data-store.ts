/**
 * The tenant data-store bridge over `IDatabaseService` (M101c, V8-8).
 *
 * `ITenantDataStore` and `ITenantIsolationStrategy` are declared in
 * `@setu-ts/common` so this package can implement them by name without
 * importing `@setu-ts/multi-tenancy-plugin` (AI_GUIDELINES §2.2). The bridge
 * is the ONLY shipped `ITenantDataStore` that writes to the database an
 * application actually uses: the multi-tenancy plugin's default
 * `MemoryTenantDataStore` partitions an in-memory map and has no bridge to a
 * real backend.
 *
 * The bridge is a `RegistryFactory`, resolved by the multi-tenancy plugin in
 * `onInit` (the first phase at which the registry holds every capability), so
 * it can read `CAPABILITIES.DATABASE` even when `DatabasePlugin` is registered
 * after the tenancy plugin.
 *
 * **Isolation is `column` only.** `IRepository` offers no schema or database
 * switch, so a `'schema'` or `'database'` strategy is refused by name
 * (`TenantStoreStrategyUnsupportedError`) rather than silently accepted — a
 * silent accept would be the X18-5 defect in a shipped store.
 *
 * **No write can move a row between tenants.** Every read conjoins the tenant
 * column to its `where`, the tenant column is spread/stamped LAST so a caller's
 * filter or payload cannot override it, and every `update` payload has the
 * tenant column STRIPPED. `update` and `delete` look the row up under the
 * tenant first, so a foreign tenant's id is a no-op.
 *
 * **The ownership check and the write are two calls, not one.** `IRepository`
 * has no conditional write, so between them another request can delete the
 * checked row and a row from another tenant can take its id; the write then
 * addresses that row. That needs a primary key REUSED across tenants, which a
 * backend refuses while the original row exists (the memory adapter does too
 * since M101c) and which a generated key never produces — so let the backend
 * generate keys, or treat a caller-supplied key as tenant-scoped data. An
 * `update` whose returned row carries another tenant's column is refused
 * rather than returned, so the race can never read a foreign row back.
 *
 * **`find` filters are equality only.** A filter key starting with `$` or a
 * non-scalar value is refused, because some backends (MongoDB) read those as
 * query operators rather than as values.
 *
 * **Lookup by key goes through the repository's own `findById`.** The bridge
 * never names the key field itself: an entity whose primary key is not `id`
 * (a Mongo `primaryKey: 'user_id'`, a Drizzle composite key) is addressed the
 * way its adapter is configured, and the tenant column is then checked on the
 * row that comes back. Writing `where: { id }` instead would silently answer
 * "not found" for every such entity.
 *
 * @module
 */
import type {
  EntityKey,
  IServiceRegistry,
  ITenantDataStore,
  ITenantIsolationStrategy,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '../interfaces/index.ts';

/**
 * Thrown by {@linkcode DatabaseTenantDataStore.useIsolation} when the
 * resolved isolation strategy is not `'column'`.
 *
 * `IRepository` offers no schema or database switch, so a `'schema'` or
 * `'database'` strategy cannot be delivered by this store. It is refused by
 * name at `useIsolation` time (during the plugin's `register()`/`onInit`)
 * rather than silently accepted — a silent accept would leave the isolation
 * logical-only, the X18-5 defect, in a store that looks like it delivers it.
 *
 * @since 0.9.0
 */
export class TenantStoreStrategyUnsupportedError extends Error {
  /**
   * Records the refused isolation strategy.
   *
   * @param message - The refusal, naming the strategy kind and why the bridge
   *   cannot express it
   */
  constructor(message: string) {
    super(message);
    this.name = 'TenantStoreStrategyUnsupportedError';
  }
}

/**
 * Refuses a `find` filter that is not a plain equality map.
 *
 * `ITenantDataStore.find` is equality matching (the memory store's semantics),
 * but the filter reaches the backend's `where`, and MongoDB reads a `$`-prefixed
 * key (`$where`, `$or`) or an object value (`{ $ne: … }`) as a QUERY OPERATOR —
 * server-side JavaScript in the `$where` case. Neither the key nor the value is
 * echoed: a filter is often request-derived.
 */
function assertEqualityFilter(filter: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) {
      throw new TypeError(
        "DatabaseTenantDataStore.find: a filter key may not start with '$' (equality only)",
      );
    }
    const scalar = value === null || value instanceof Date ||
      ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
    if (!scalar) {
      throw new TypeError(
        'DatabaseTenantDataStore.find: filter values must be scalars (equality only)',
      );
    }
  }
}

/** The default tenant column, when neither the option nor a strategy names one. */
const DEFAULT_TENANT_COLUMN = 'tenant_id';

/**
 * An `ITenantDataStore` over `IDatabaseService`, isolating tenants by a
 * column stamped on every row.
 *
 * Constructed by {@linkcode createDatabaseTenantDataStore} (the factory the
 * multi-tenancy plugin resolves in `onInit`), or directly by an application
 * that holds its own `IDatabaseService` (a test, the `custom` arm).
 *
 * @since 0.9.0
 */
export class DatabaseTenantDataStore implements ITenantDataStore {
  readonly #service: IDatabaseService;
  /** The column named by the constructor's `tenantColumn`, if any. */
  readonly #configuredColumn: string | undefined;
  /** The column adopted from a `'column'` strategy via `useIsolation`, if any. */
  #resolvedColumn: string | undefined;

  /**
   * Binds the store to the database service it reads and writes through.
   *
   * @param service - The database service the store reads and writes through
   * @param tenantColumn - The tenant column to stamp and conjoin; when omitted
   *   the column is adopted from a `'column'` strategy handed to
   *   {@linkcode useIsolation}, else it defaults to `'tenant_id'`. Meant for a
   *   store used OUTSIDE the multi-tenancy plugin; under the plugin, name the
   *   column on the strategy instead, since the plugin always hands one over
   *   and a different column here throws at `useIsolation`
   */
  constructor(service: IDatabaseService, tenantColumn?: string) {
    this.#service = service;
    this.#configuredColumn = tenantColumn;
  }

  /**
   * The effective tenant column: a `'column'` strategy's column if one was
   * handed to {@linkcode useIsolation}, else the configured `tenantColumn`,
   * else `'tenant_id'`.
   */
  #column(): string {
    if (this.#resolvedColumn !== undefined) return this.#resolvedColumn;
    if (this.#configuredColumn !== undefined) return this.#configuredColumn;
    return DEFAULT_TENANT_COLUMN;
  }

  /**
   * Receives the resolved isolation strategy. Accepts `'column'` (adopting its
   * column unless a `tenantColumn` was given, in which case a disagreement
   * throws naming both); throws {@linkcode TenantStoreStrategyUnsupportedError}
   * for `'schema'` and `'database'` — `IRepository` has no schema or database
   * switch, so a silent accept would leave the isolation logical-only.
   */
  useIsolation(strategy: ITenantIsolationStrategy): void {
    if (strategy.kind === 'column') {
      const column = strategy.getTenantColumn();
      if (this.#configuredColumn !== undefined && this.#configuredColumn !== column) {
        throw new TenantStoreStrategyUnsupportedError(
          `new DatabaseTenantDataStore(service, '${this.#configuredColumn}') ` +
            `disagrees with the isolation strategy's column '${column}'; name the same column ` +
            `in both, or omit the tenantColumn argument to adopt the strategy's`,
        );
      }
      this.#resolvedColumn = column;
      return;
    }
    throw new TenantStoreStrategyUnsupportedError(
      `DatabaseTenantDataStore supports only the 'column' isolation strategy; ` +
        `'${strategy.kind}' has no schema or database switch in IRepository`,
    );
  }

  /** A repository over the named entity, addressed by a scalar/composite `EntityKey`. */
  #repo(
    entity: string,
  ): import('../interfaces/index.ts').IRepository<Record<string, unknown>, EntityKey> {
    return this.#service.getRepository<Record<string, unknown>, EntityKey>(entity);
  }

  async findAll<E>(tenantId: string, entity: string): Promise<readonly E[]> {
    const col = this.#column();
    const rows = await this.#repo(entity).findAll({ where: { [col]: tenantId } });
    return rows as unknown as readonly E[];
  }

  /**
   * Reads the row by key through the repository's own `findById` and returns
   * it only when it belongs to `tenantId`; `null` otherwise.
   */
  async #ownedRow(
    tenantId: string,
    entity: string,
    id: EntityKey,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.#repo(entity).findById(id);
    if (row === null || row[this.#column()] !== tenantId) return null;
    return row;
  }

  async findById<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
  ): Promise<E | null> {
    const row = await this.#ownedRow(tenantId, entity, id as EntityKey);
    return row as unknown as (E | null);
  }

  async find<E>(
    tenantId: string,
    entity: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly E[]> {
    const col = this.#column();
    assertEqualityFilter(filter);
    // The tenant column is spread LAST so a caller's filter cannot override it.
    const rows = await this.#repo(entity).findAll({ where: { ...filter, [col]: tenantId } });
    return rows as unknown as readonly E[];
  }

  async create<E>(
    tenantId: string,
    entity: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E> {
    const col = this.#column();
    // The tenant column is stamped LAST so a caller's payload cannot override it.
    const created = await this.#repo(entity).create({ ...data, [col]: tenantId });
    return created as unknown as E;
  }

  async update<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E | null> {
    const col = this.#column();
    const repo = this.#repo(entity);
    // Look the row up under the tenant first: a foreign tenant's id is a no-op,
    // not a mutation of another tenant's row.
    const existing = await this.#ownedRow(tenantId, entity, id as EntityKey);
    if (existing === null) return null;
    // Strip the tenant column from the payload so no update can move a row
    // between tenants.
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key !== col) stripped[key] = value;
    }
    const updated = await repo.update(id as EntityKey, stripped);
    // The check and the write are two calls (see the class JSDoc); never hand
    // back a row the race retargeted to another tenant.
    if (updated[col] !== tenantId) {
      throw new Error(
        `DatabaseTenantDataStore: the '${entity}' row changed tenant between the ownership ` +
          `check and the update; the write was not returned`,
      );
    }
    return updated as unknown as E;
  }

  async delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean> {
    // Look the row up under the tenant first: a foreign tenant's id is a no-op.
    const existing = await this.#ownedRow(tenantId, entity, id as EntityKey);
    if (existing === null) return false;
    return this.#repo(entity).delete(id as EntityKey);
  }
}

/**
 * Builds the tenant data-store bridge as a {@linkcode RegistryFactory}, for
 * the multi-tenancy plugin's `dataStore` option.
 *
 * The returned factory resolves `CAPABILITIES.DATABASE` from the registry it
 * is handed — typed as `IDatabaseService`, the token's documented interface —
 * and returns a {@linkcode DatabaseTenantDataStore} over it. Resolving at
 * `onInit` (not `register()`) is what lets `DatabasePlugin` be registered
 * after the tenancy plugin: every `register()` phase completes before any
 * `onInit`, so no ordering edge is needed.
 *
 * The tenant column comes from the plugin's isolation strategy, which the
 * plugin always hands the store: `'column-per-tenant'` uses `'tenant_id'`, and
 * `database: new ColumnPerTenant('org_id')` names another column. There is no
 * second place to name it, so the two cannot disagree.
 *
 * @returns A factory the multi-tenancy plugin resolves in `onInit`
 *
 * @example
 * ```typescript
 * import { DatabasePlugin, createDatabaseTenantDataStore } from '@setu-ts/database-plugin';
 * import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'memory' }),
 *     MultiTenancyPlugin({
 *       resolver: 'header',
 *       dataStore: createDatabaseTenantDataStore(),
 *     }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseTenantDataStore(): RegistryFactory<ITenantDataStore> {
  return (services: IServiceRegistry): ITenantDataStore => {
    const service = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    return new DatabaseTenantDataStore(service);
  };
}

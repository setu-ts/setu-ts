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
 * tenant first (two calls) so a foreign tenant's id is a no-op, not a mutation
 * of another tenant's row.
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
  /** The column named by `createDatabaseTenantDataStore({ tenantColumn })`, if any. */
  readonly #configuredColumn: string | undefined;
  /** The column adopted from a `'column'` strategy via `useIsolation`, if any. */
  #resolvedColumn: string | undefined;

  /**
   * Binds the store to the database service it reads and writes through.
   *
   * @param service - The database service the store reads and writes through
   * @param tenantColumn - The tenant column to stamp and conjoin; when omitted
   *   the column is adopted from a `'column'` strategy handed to
   *   {@linkcode useIsolation}, else it defaults to `'tenant_id'`
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
          `createDatabaseTenantDataStore({ tenantColumn: '${this.#configuredColumn}' }) ` +
            `disagrees with the isolation strategy's column '${column}'; name the same column ` +
            `in both, or omit tenantColumn to adopt the strategy's`,
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

  async findById<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
  ): Promise<E | null> {
    const col = this.#column();
    const row = await this.#repo(entity).findOne({
      where: { id: id as EntityKey, [col]: tenantId },
    });
    return row as unknown as (E | null);
  }

  async find<E>(
    tenantId: string,
    entity: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly E[]> {
    const col = this.#column();
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
    const existing = await repo.findOne({ where: { id: id as EntityKey, [col]: tenantId } });
    if (existing === null) return null;
    // Strip the tenant column from the payload so no update can move a row
    // between tenants.
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key !== col) stripped[key] = value;
    }
    const updated = await repo.update(id as EntityKey, stripped);
    return updated as unknown as E;
  }

  async delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean> {
    const col = this.#column();
    const repo = this.#repo(entity);
    // Look the row up under the tenant first: a foreign tenant's id is a no-op.
    const existing = await repo.findOne({ where: { id: id as EntityKey, [col]: tenantId } });
    if (existing === null) return false;
    return repo.delete(id as EntityKey);
  }
}

/**
 * Options for {@linkcode createDatabaseTenantDataStore}.
 *
 * @since 0.9.0
 */
export interface DatabaseTenantDataStoreOptions {
  /**
   * The tenant column to stamp on every write and conjoin to every read. When
   * omitted the column is adopted from a `'column'` strategy handed to
   * `useIsolation`, else it defaults to `'tenant_id'`. A `column` strategy
   * naming a DIFFERENT column throws at `useIsolation`.
   */
  readonly tenantColumn?: string;
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
 * @param options - The tenant column, when it differs from the strategy's or
 *   the default
 * @returns A factory the multi-tenancy plugin resolves in `onInit`
 *
 * @example
 * ```typescript
 * import { DatabasePlugin, createDatabaseTenantDataStore } from '@setu-ts/database-plugin';
 * import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'postgres', /* … *\/ }),
 *     MultiTenancyPlugin({
 *       resolver: 'header',
 *       dataStore: createDatabaseTenantDataStore(),
 *     }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseTenantDataStore(
  options?: DatabaseTenantDataStoreOptions,
): RegistryFactory<ITenantDataStore> {
  return (services: IServiceRegistry): ITenantDataStore => {
    const service = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    return new DatabaseTenantDataStore(service, options?.tenantColumn);
  };
}

// deno-lint-ignore-file require-await no-this-alias -- interface methods must be async; this alias needed for closure scope
/**
 * In-memory database adapter — zero external dependencies, used for
 * testing and lightweight scenarios.
 *
 * Implements {@linkcode IOrmAdapter} from `@hono-enterprise/common` and
 * provides a simple key-value store per entity type.
 *
 * @module
 */
import type { IOrmAdapter, ITransaction } from '@hono-enterprise/common';
import {
  applyOrderBy,
  applyPagination,
  matchesWhere,
  type NormalizedQuery,
} from '../../query/query-builder.ts';

/**
 * A single in-memory entity store keyed by entity name.
 *
 * @internal
 */
interface EntityStore {
  /** All entities in insertion order. */
  records: Record<string, unknown>[];
  /** Primary key field name (defaults to `'id'`). */
  primaryKey: string;
}

/**
 * In-memory implementation of {@linkcode IOrmAdapter}.
 *
 * Stores entities in plain `Map` structures, supporting basic CRUD,
 * filtering, sorting, pagination, and transaction semantics.
 *
 * @since 0.1.0
 */
export class MemoryAdapter implements IOrmAdapter {
  private readonly _stores = new Map<string, EntityStore>();
  private _connected = false;
  private _closed = false;

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._connected = true;
    this._closed = false;
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    this._connected = false;
    this._closed = true;
    this._stores.clear();
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && !this._closed;
  }

  /** @inheritdoc */
  async beginTransaction(): Promise<ITransaction> {
    if (!this.isReady()) {
      throw new Error('MemoryAdapter is not connected — call connect() first');
    }

    // Snapshot current stores for rollback.
    const snapshot = new Map<string, Record<string, unknown>[]>();
    for (const [name, store] of this._stores.entries()) {
      snapshot.set(name, store.records.map((r) => ({ ...r })));
    }

    let committed = false;
    const self = this;

    return {
      async commit(): Promise<void> {
        committed = true;
      },
      async rollback(): Promise<void> {
        if (committed) return;
        // Restore snapshot.
        self._stores.clear();
        for (const [name, records] of snapshot.entries()) {
          self._stores.set(name, { records, primaryKey: 'id' });
        }
      },
    };
  }

  /**
   * Returns the internal store for an entity, creating it lazily.
   *
   * @param entity - Entity name
   * @param primaryKey - Primary key field (defaults to `'id'`)
   * @returns The entity store
   */
  getStore(entity: string, primaryKey: string = 'id'): EntityStore {
    let store = this._stores.get(entity);
    if (!store) {
      store = { records: [], primaryKey };
      this._stores.set(entity, store);
    }
    return store;
  }

  /**
   * Query entities with full filtering, sorting, and pagination.
   *
   * @param entity - Entity name
   * @param query - Normalized query options
   * @returns Matching entities
   */
  async queryEntities(
    entity: string,
    query: NormalizedQuery,
  ): Promise<Record<string, unknown>[]> {
    const store = this.getStore(entity);
    let results = store.records;

    // Filter.
    if (query.where && Object.keys(query.where).length > 0) {
      results = results.filter((row) => matchesWhere(row, query.where));
    }

    // Sort.
    results = applyOrderBy(results, query.orderBy);

    // Paginate.
    results = applyPagination(results, query.offset, query.limit);

    return results.map((r) => ({ ...r }));
  }

  /**
   * Find a single entity by its primary key value.
   *
   * @param entity - Entity name
   * @param id - Primary key value
   * @returns The entity or `null`
   */
  async findEntityById(
    entity: string,
    id: string | number,
  ): Promise<Record<string, unknown> | null> {
    const store = this.getStore(entity);
    const record = store.records.find((r) => r[store.primaryKey] === id);
    if (!record) return null;
    return { ...record };
  }

  /**
   * Insert a new entity. Generates an `id` if absent.
   *
   * @param entity - Entity name
   * @param data - Entity data
   * @returns The inserted entity
   */
  async insertEntity(
    entity: string,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(entity);
    const record: Record<string, unknown> = { ...data };
    if (record[store.primaryKey] === undefined) {
      record[store.primaryKey] = crypto.randomUUID();
    }
    store.records.push(record);
    return { ...record };
  }

  /**
   * Update an existing entity by primary key, merging fields.
   *
   * @param entity - Entity name
   * @param id - Primary key value
   * @param data - Fields to merge
   * @returns The updated entity
   * @throws {Error} If the entity does not exist
   */
  async updateEntity(
    entity: string,
    id: string | number,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(entity);
    const index = store.records.findIndex((r) => r[store.primaryKey] === id);
    if (index === -1) {
      throw new Error(`Entity '${entity}' with id '${id}' not found`);
    }
    store.records[index] = { ...store.records[index], ...data };
    return { ...store.records[index] };
  }

  /**
   * Delete an entity by primary key.
   *
   * @param entity - Entity name
   * @param id - Primary key value
   * @returns `true` when deleted, `false` if not found
   */
  async deleteEntity(entity: string, id: string | number): Promise<boolean> {
    const store = this.getStore(entity);
    const index = store.records.findIndex((r) => r[store.primaryKey] === id);
    if (index === -1) return false;
    store.records.splice(index, 1);
    return true;
  }

  /**
   * Count entities matching a filter.
   *
   * @param entity - Entity name
   * @param where - Filter conditions
   * @returns Matching count
   */
  async countEntities(
    entity: string,
    where: Record<string, unknown>,
  ): Promise<number> {
    const store = this.getStore(entity);
    if (Object.keys(where).length === 0) {
      return store.records.length;
    }
    return store.records.filter((row) => matchesWhere(row, where)).length;
  }
}

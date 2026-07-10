/**
 * In-memory database adapter — zero external dependencies, used for
 * testing and lightweight scenarios.
 *
 * Implements {@linkcode IOrmAdapter} from `@hono-enterprise/common` and
 * provides a simple key-value store per entity type with per-transaction
 * overlay semantics (buffered creates, update shadows, delete tombstones).
 *
 * @module
 */
import type { IOrmAdapter } from '@hono-enterprise/common';
import type { IAdapterTransaction } from '../adapter.ts';
import {
  applyOrderBy,
  applyPagination,
  matchesWhere,
  type NormalizedQuery,
} from '../../query/query-builder.ts';
import type { DataSource } from '../../repositories/base-repository.ts';

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
 * Per-transaction overlay that buffers writes so the committed store is not
 * mutated until `commit()` is called.
 *
 * - **Creates** are buffered in `creates` array.
 * - **Update shadows** (`shadows` Map) map primary-key → new row snapshot;
 *   reads see the shadow instead of the committed row.
 * - **Delete tombstones** (`tombstones` Set) mark primary-keys as deleted
 *   within this transaction.
 *
 * `commit()` flushes all overlay data to the real stores (last-write-wins on
 * rows concurrently modified outside the transaction — acceptable for a test
 * adapter). `rollback()` discards the overlay entirely.
 *
 * @internal
 */
interface TxOverlay {
  creates: Array<{ entity: string; record: Record<string, unknown> }>;
  shadows: Map<string, { entity: string; id: unknown; record: Record<string, unknown> }>;
  tombstones: Set<string>;
}

function overlayKey(entity: string, id: unknown): string {
  return `${entity}::${id}`;
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
  connect(): Promise<void> {
    this._connected = true;
    this._closed = false;
    return Promise.resolve();
  }

  /** @inheritdoc */
  disconnect(): Promise<void> {
    this._connected = false;
    this._closed = true;
    this._stores.clear();
    return Promise.resolve();
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && !this._closed;
  }

  /** @inheritdoc */
  beginTransaction(): Promise<IAdapterTransaction> {
    if (!this.isReady()) {
      throw new Error('MemoryAdapter is not connected — call connect() first');
    }

    const overlay: TxOverlay = {
      creates: [],
      shadows: new Map(),
      tombstones: new Set(),
    };

    let committed = false;
    let rolledBack = false;

    return Promise.resolve({
      createDataSource: (entity: string): DataSource =>
        this.createOverlayDataSource(entity, overlay),

      commit: (): Promise<void> => {
        if (committed || rolledBack) {
          throw new Error('Transaction already finalized');
        }
        committed = true;
        // Flush creates
        for (const entry of overlay.creates) {
          const store = this.getStore(entry.entity);
          store.records.push({ ...entry.record });
        }
        // Flush update shadows
        for (const shadow of overlay.shadows.values()) {
          const store = this.getStore(shadow.entity);
          const idx = store.records.findIndex((r) => r[store.primaryKey] === shadow.id);
          if (idx !== -1) {
            store.records[idx] = { ...shadow.record };
          }
        }
        // Flush delete tombstones
        for (const key of overlay.tombstones) {
          const [ent, idStr] = key.split('::');
          const store = this.getStore(ent);
          const id = Number(idStr) === Number(idStr) && !isNaN(Number(idStr))
            ? Number(idStr)
            : idStr;
          const idx = store.records.findIndex((r) => r[store.primaryKey] === id);
          if (idx !== -1) {
            store.records.splice(idx, 1);
          }
        }
        return Promise.resolve();
      },

      rollback: (): Promise<void> => {
        if (committed || rolledBack) return Promise.resolve();
        rolledBack = true;
        // Discard overlay — committed store untouched.
        return Promise.resolve();
      },
    });
  }

  /**
   * Build a data source that reads through the overlay (committed rows with
   * shadows/tombstones/creates applied) and buffers writes into the overlay.
   *
   * @param entity - Entity name
   * @param overlay - The transaction overlay to buffer writes into
   * @returns DataSource bound to the overlay
   */
  private createOverlayDataSource(
    entity: string,
    overlay: TxOverlay,
  ): DataSource {
    /**
     * Resolve the effective records for a transaction read: committed rows
     * with update shadows applied, tombstoned rows removed, buffered creates
     * appended.
     */
    const effectiveRecords = (): Record<string, unknown>[] => {
      const store = this.getStore(entity);
      const pk = store.primaryKey;
      return store.records
        .map((r) => {
          const key = overlayKey(entity, r[pk]);
          if (overlay.tombstones.has(key)) return null; // deleted
          const shadow = overlay.shadows.get(key);
          if (shadow) return shadow.record;
          return r;
        })
        .filter((r): r is Record<string, unknown> => r !== null)
        .concat(overlay.creates.filter((c) => c.entity === entity).map((c) => c.record));
    };

    return {
      findAll: (query) => {
        let results = effectiveRecords();
        if (query.where && Object.keys(query.where).length > 0) {
          results = results.filter((row) => matchesWhere(row, query.where));
        }
        results = applyOrderBy(results, query.orderBy);
        results = applyPagination(results, query.offset, query.limit);
        return Promise.resolve(results.map((r) => ({ ...r })));
      },

      findById: (id) => {
        const records = effectiveRecords();
        const store = this.getStore(entity);
        const record = records.find((r) => r[store.primaryKey] === id);
        if (!record) return Promise.resolve(null);
        return Promise.resolve({ ...record });
      },

      create: (data) => {
        const store = this.getStore(entity);
        const record: Record<string, unknown> = { ...data };
        if (record[store.primaryKey] === undefined) {
          record[store.primaryKey] = crypto.randomUUID();
        }
        overlay.creates.push({ entity, record });
        return Promise.resolve({ ...record });
      },

      update: (id, data) => {
        const store = this.getStore(entity);
        // Find in effective records
        const effective = effectiveRecords();
        const target = effective.find((r) => r[store.primaryKey] === id);
        if (!target) {
          return Promise.reject(new Error(`Entity '${entity}' with id '${id}' not found`));
        }
        const newRecord = { ...target, ...data };
        overlay.shadows.set(overlayKey(entity, id), { entity, id, record: newRecord });
        return Promise.resolve({ ...newRecord });
      },

      delete: (id) => {
        const store = this.getStore(entity);
        const effective = effectiveRecords();
        const target = effective.find((r) => r[store.primaryKey] === id);
        if (!target) return Promise.resolve(false);
        overlay.tombstones.add(overlayKey(entity, id));
        return Promise.resolve(true);
      },

      count: (where) => {
        let results = effectiveRecords();
        if (Object.keys(where).length > 0) {
          results = results.filter((row) => matchesWhere(row, where));
        }
        return Promise.resolve(results.length);
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
  queryEntities(
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

    return Promise.resolve(results.map((r) => ({ ...r })));
  }

  /**
   * Find a single entity by its primary key value.
   *
   * @param entity - Entity name
   * @param id - Primary key value
   * @returns The entity or `null`
   */
  findEntityById(
    entity: string,
    id: string | number,
  ): Promise<Record<string, unknown> | null> {
    const store = this.getStore(entity);
    const record = store.records.find((r) => r[store.primaryKey] === id);
    if (!record) return Promise.resolve(null);
    return Promise.resolve({ ...record });
  }

  /**
   * Insert a new entity. Generates an `id` if absent.
   *
   * @param entity - Entity name
   * @param data - Entity data
   * @returns The inserted entity
   */
  insertEntity(
    entity: string,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(entity);
    const record: Record<string, unknown> = { ...data };
    if (record[store.primaryKey] === undefined) {
      record[store.primaryKey] = crypto.randomUUID();
    }
    store.records.push(record);
    return Promise.resolve({ ...record });
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
  updateEntity(
    entity: string,
    id: string | number,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(entity);
    const index = store.records.findIndex((r) => r[store.primaryKey] === id);
    if (index === -1) {
      return Promise.reject(new Error(`Entity '${entity}' with id '${id}' not found`));
    }
    store.records[index] = { ...store.records[index], ...data };
    return Promise.resolve({ ...store.records[index] });
  }

  /**
   * Delete an entity by primary key.
   *
   * @param entity - Entity name
   * @param id - Primary key value
   * @returns `true` when deleted, `false` if not found
   */
  deleteEntity(entity: string, id: string | number): Promise<boolean> {
    const store = this.getStore(entity);
    const index = store.records.findIndex((r) => r[store.primaryKey] === id);
    if (index === -1) return Promise.resolve(false);
    store.records.splice(index, 1);
    return Promise.resolve(true);
  }

  /**
   * Count entities matching a filter.
   *
   * @param entity - Entity name
   * @param where - Filter conditions
   * @returns Matching count
   */
  countEntities(
    entity: string,
    where: Record<string, unknown>,
  ): Promise<number> {
    const store = this.getStore(entity);
    if (Object.keys(where).length === 0) {
      return Promise.resolve(store.records.length);
    }
    return Promise.resolve(store.records.filter((row) => matchesWhere(row, where)).length);
  }

  /** @inheritdoc — raw query not supported on memory adapter. */
  rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    return Promise.reject(new Error('The memory adapter does not support raw SQL queries.'));
  }
}

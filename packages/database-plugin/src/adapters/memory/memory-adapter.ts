/**
 * In-memory database adapter — zero external dependencies, used for
 * testing and lightweight scenarios.
 *
 * Implements {@linkcode IDatabaseAdapter} from `@setu-ts/common` and
 * provides a simple key-value store per entity type with per-transaction
 * overlay semantics (buffered creates, update shadows, delete tombstones).
 *
 * Supports composite keys: when `primaryKey` is a `string[]` the store
 * matches on every named column, and the overlay composes a stable
 * multi-column key from the column values.
 *
 * @module
 */
import type {
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDatabaseAdapter,
} from '@setu-ts/common';
import {
  applyOrderBy,
  applyPagination,
  matchesFilter,
  matchesWhere,
  type NormalizedQuery,
  projectFields,
  unknownColumnError,
} from '../../query/query-builder.ts';
import { resolveKeyColumns } from '../../query/key-target.ts';
import type { DataSource } from '../../repositories/base-repository.ts';

/**
 * A single in-memory entity store keyed by entity name.
 *
 * @internal
 */
interface EntityStore {
  /** All entities in insertion order. */
  records: Record<string, unknown>[];
  /**
   * Primary key columns, normalised to a `readonly string[]`.
   * The scalar case is a one-element array; composite keys are multi-element.
   */
  primaryKey: readonly string[];
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
  shadows: Map<string, { entity: string; id: EntityKey; record: Record<string, unknown> }>;
  tombstones: Set<string>;
}

/**
 * Compose a stable overlay key from an entity name and an {@linkcode EntityKey}.
 *
 * For scalar keys the shape is `entity::scalar`. For composite keys the values
 * are joined with `|` — the delimiter is chosen so it cannot appear inside the
 * column values we accept (`string | number`), and it preserves ordering so the
 * same composite key always produces the same string regardless of how the
 * caller writes the record literal.
 *
 * @param entity - Entity name
 * @param id - Primary key value (scalar or composite record)
 * @returns A stable string key for overlay maps/sets
 * @since 0.1.0
 */
function overlayKey(entity: string, id: EntityKey): string {
  if (typeof id === 'string' || typeof id === 'number') {
    return `${entity}::${id}`;
  }
  // Composite record key — compose a deterministic multi-column key.
  const parts = Object.keys(id).sort();
  return `${entity}::${parts.map((k) => `${k}=${id[k]}`).join('|')}`;
}

/**
 * Find the index of a record matching the given {@linkcode EntityKey} in the
 * store's record list. Works for both scalar (one-element) and composite keys.
 *
 * @param store - The entity store to search
 * @param id - The primary key value to match
 * @returns The record index, or `-1` when not found
 * @since 0.1.0
 */
function findRecordIndex(store: EntityStore, id: EntityKey): number {
  if (store.primaryKey.length === 1) {
    return store.records.findIndex((r) => r[store.primaryKey[0]] === id);
  }
  // Composite key — id is a record with known columns.
  return store.records.findIndex((r) => {
    for (const col of store.primaryKey) {
      const idRecord = id as Record<string, string | number>;
      if (r[col] !== idRecord[col]) return false;
    }
    return true;
  });
}

/**
 * Parse a composite overlay key string back into an {@linkcode EntityKey}.
 * The key format for composite records is `key1=val1|key2=val2` (the entity
 * prefix was already stripped by the caller).
 *
 * @param keyString - The overlay key string after the entity prefix
 * @param entity - Entity name (used for error messages)
 * @param store - The entity store whose primary key columns define the shape
 * @returns The parsed composite key record
 * @throws {Error} When the key shape does not match the store's primary key
 * @since 0.1.0
 */
function parseCompositeOverlayKey(
  keyString: string,
  entity: string,
  store: EntityStore,
): EntityKey {
  const result: Record<string, string | number> = {};
  for (const segment of keyString.split('|')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(
        `MemoryAdapter: invalid overlay key format for entity '${entity}': '${segment}'`,
      );
    }
    const key = segment.slice(0, eqIndex);
    const valStr = segment.slice(eqIndex + 1);
    const val = Number(valStr) === Number(valStr) && !isNaN(Number(valStr))
      ? Number(valStr)
      : valStr;
    result[key] = val;
  }
  // Validate that all expected columns are present.
  for (const col of store.primaryKey) {
    if (result[col] === undefined) {
      throw new Error(
        `MemoryAdapter: overlay key for entity '${entity}' is missing column '${col}'`,
      );
    }
  }
  return result;
}

/**
 * In-memory implementation of {@linkcode IDatabaseAdapter}.
 *
 * Stores entities in plain `Map` structures, supporting basic CRUD,
 * filtering, sorting, pagination, and transaction semantics.
 *
 * @since 0.1.0
 */
export class MemoryAdapter implements IDatabaseAdapter {
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
          const idx = findRecordIndex(store, shadow.id);
          if (idx !== -1) {
            store.records[idx] = { ...shadow.record };
          }
        }
        // Flush delete tombstones
        for (const key of overlay.tombstones) {
          const [ent, ...rest] = key.split('::');
          const store = this.getStore(ent);
          const id = store.primaryKey.length === 1
            ? (Number(rest.join('')) === Number(rest.join('')) && !isNaN(Number(rest.join('')))
              ? Number(rest.join(''))
              : rest.join(''))
            : parseCompositeOverlayKey(rest.join('::'), ent, store);
          const idx = findRecordIndex(this.getStore(ent), id);
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
      return store.records
        .map((r) => {
          const idForOverlay = store.primaryKey.length === 1
            ? r[store.primaryKey[0]] as EntityKey
            : (() => {
              const rec: Record<string, string | number> = {};
              for (const c of store.primaryKey) rec[c] = r[c] as string | number;
              return rec;
            })();
          const key = overlayKey(entity, idForOverlay);
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
        // Checked against the rows this transaction can see, so a column
        // created inside the transaction counts as known.
        const columnError = unknownColumnError(entity, results, query);
        if (columnError) return Promise.reject(columnError);
        if (query.where && Object.keys(query.where).length > 0) {
          results = results.filter((row) => matchesWhere(row, query.where));
        }
        if (query.filter !== undefined) {
          const filter = query.filter;
          results = results.filter((row) => matchesFilter(row, filter));
        }
        results = applyOrderBy(results, query.orderBy);
        results = applyPagination(results, query.offset, query.limit);
        // `select` is applied HERE, like every other adapter: the DataSource is
        // the single place a query is evaluated, so BaseRepository does not need
        // to re-project (and must not re-paginate).
        if (query.select.length > 0) {
          return Promise.resolve(
            results.map((r) => projectFields(r, query.select) as Record<string, unknown>),
          );
        }
        return Promise.resolve(results.map((r) => ({ ...r })));
      },

      findById: (id) => {
        const records = effectiveRecords();
        const store = this.getStore(entity);
        const idx = findRecordIndexForRecords(records, store, id);
        if (idx === -1) return Promise.resolve(null);
        return Promise.resolve({ ...records[idx] });
      },

      create: (data) => {
        const store = this.getStore(entity);
        const record: Record<string, unknown> = { ...data };
        // Generate missing key columns.
        for (const col of store.primaryKey) {
          if (record[col] === undefined) {
            record[col] = crypto.randomUUID();
          }
        }
        overlay.creates.push({ entity, record });
        return Promise.resolve({ ...record });
      },

      update: (id, data) => {
        const store = this.getStore(entity);
        // Find in effective records
        const effective = effectiveRecords();
        const targetIndex = findRecordIndexForRecords(effective, store, id);
        if (targetIndex === -1) {
          return Promise.reject(new Error(`Entity '${entity}' with id not found`));
        }
        const target = effective[targetIndex];
        const newRecord = { ...target, ...data };
        overlay.shadows.set(overlayKey(entity, id), { entity, id, record: newRecord });
        return Promise.resolve({ ...newRecord });
      },

      delete: (id) => {
        const store = this.getStore(entity);
        const effective = effectiveRecords();
        const targetIndex = findRecordIndexForRecords(effective, store, id);
        if (targetIndex === -1) return Promise.resolve(false);
        overlay.tombstones.add(overlayKey(entity, id));
        return Promise.resolve(true);
      },

      count: (where, filter) => {
        let results = effectiveRecords();
        if (Object.keys(where).length > 0) {
          results = results.filter((row) => matchesWhere(row, where));
        }
        if (filter !== undefined) {
          results = results.filter((row) => matchesFilter(row, filter));
        }
        return Promise.resolve(results.length);
      },
    };
  }

  /**
   * @inheritdoc
   *
   * Builds a non-transactional data source reading and writing the committed
   * store directly. Initializing the store here (rather than on first read)
   * is what fixes the primary key for the entity before any query runs.
   *
   * @param entity - Entity name
   * @param primaryKey - Primary key field(s), defaults to `['id']`
   */
  createDataSource(entity: string, primaryKey: string | readonly string[] = 'id'): DataSource {
    this.getStore(entity, primaryKey); // Ensure the store (and its key) exists.
    return {
      findAll: (query) => this.queryEntities(entity, query),
      findById: (id) => this.findEntityById(entity, id),
      create: (data) => this.insertEntity(entity, data),
      update: (id, data) => this.updateEntity(entity, id, data),
      delete: (id) => this.deleteEntity(entity, id),
      count: (where, filter) => this.countEntities(entity, where, filter),
    };
  }

  /**
   * Returns the internal store for an entity, creating it lazily.
   *
   * @param entity - Entity name
   * @param primaryKey - Primary key field(s), defaults to `['id']`
   * @returns The entity store
   */
  getStore(entity: string, primaryKey: string | readonly string[] = 'id'): EntityStore {
    const columns = resolveKeyColumns(primaryKey);
    let store = this._stores.get(entity);
    if (!store) {
      store = { records: [], primaryKey: columns };
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
    const columnError = unknownColumnError(entity, store.records, query);
    if (columnError) return Promise.reject(columnError);
    let results = store.records;

    // Filter.
    if (query.where && Object.keys(query.where).length > 0) {
      results = results.filter((row) => matchesWhere(row, query.where));
    }
    if (query.filter !== undefined) {
      const filter = query.filter;
      results = results.filter((row) => matchesFilter(row, filter));
    }

    // Sort.
    results = applyOrderBy(results, query.orderBy);

    // Paginate.
    results = applyPagination(results, query.offset, query.limit);

    // Project. The DataSource is the single place a query is evaluated, so
    // `select` is honored here rather than re-projected by BaseRepository
    // (which must not re-apply any of these steps — re-applying `offset` made
    // every page after the first come back empty).
    if (query.select.length > 0) {
      return Promise.resolve(
        results.map((r) => projectFields(r, query.select) as Record<string, unknown>),
      );
    }

    return Promise.resolve(results.map((r) => ({ ...r })));
  }

  /**
   * Find a single entity by its primary key value.
   *
   * @param entity - Entity name
   * @param id - Primary key value (scalar or composite record)
   * @returns The entity or `null`
   */
  findEntityById(
    entity: string,
    id: EntityKey,
  ): Promise<Record<string, unknown> | null> {
    const store = this.getStore(entity);
    const idx = findRecordIndex(store, id);
    if (idx === -1) return Promise.resolve(null);
    return Promise.resolve({ ...store.records[idx] });
  }

  /**
   * Insert a new entity. Generates key values if absent.
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
    // Generate missing key columns.
    for (const col of store.primaryKey) {
      if (record[col] === undefined) {
        record[col] = crypto.randomUUID();
      }
    }
    store.records.push(record);
    return Promise.resolve({ ...record });
  }

  /**
   * Update an existing entity by primary key, merging fields.
   *
   * @param entity - Entity name
   * @param id - Primary key value (scalar or composite record)
   * @param data - Fields to merge
   * @returns The updated entity
   * @throws {Error} If the entity does not exist
   */
  updateEntity(
    entity: string,
    id: EntityKey,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(entity);
    const index = findRecordIndex(store, id);
    if (index === -1) {
      return Promise.reject(new Error(`Entity '${entity}' with id not found`));
    }
    store.records[index] = { ...store.records[index], ...data };
    return Promise.resolve({ ...store.records[index] });
  }

  /**
   * Delete an entity by primary key.
   *
   * @param entity - Entity name
   * @param id - Primary key value (scalar or composite record)
   * @returns `true` when deleted, `false` if not found
   */
  deleteEntity(entity: string, id: EntityKey): Promise<boolean> {
    const store = this.getStore(entity);
    const index = findRecordIndex(store, id);
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
    filter?: FilterExpression,
  ): Promise<number> {
    const store = this.getStore(entity);
    if (Object.keys(where).length === 0 && filter === undefined) {
      return Promise.resolve(store.records.length);
    }
    return Promise.resolve(
      store.records.filter((row) =>
        matchesWhere(row, where) && (filter === undefined || matchesFilter(row, filter))
      ).length,
    );
  }

  /** @inheritdoc — raw query not supported on memory adapter. */
  rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    return Promise.reject(new Error('The memory adapter does not support raw SQL queries.'));
  }
}

/**
 * Find the index of a record matching the given {@linkcode EntityKey} in a
 * standalone record list (used by the overlay data source).
 *
 * @param records - The record list to search
 * @param store - The entity store defining the primary key columns
 * @param id - The primary key value to match
 * @returns The record index, or `-1` when not found
 * @since 0.1.0
 */
function findRecordIndexForRecords(
  records: Record<string, unknown>[],
  store: EntityStore,
  id: EntityKey,
): number {
  if (store.primaryKey.length === 1) {
    return records.findIndex((r) => r[store.primaryKey[0]] === id);
  }
  // Composite key — id is a record with known columns.
  return records.findIndex((r) => {
    for (const col of store.primaryKey) {
      const idRecord = id as Record<string, string | number>;
      if (r[col] !== idRecord[col]) return false;
    }
    return true;
  });
}

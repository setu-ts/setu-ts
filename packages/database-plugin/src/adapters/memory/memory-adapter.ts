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
  CursorPayload,
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDatabaseAdapter,
  PageResult,
} from '@setu-ts/common';
import {
  decodeCursor,
  keysetPredicate,
  mintNextCursor,
  resolveKeysetSort,
  sortFingerprint,
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
import { UnsupportedQueryFeatureError, UnsupportedRawQueryError } from '../../errors.ts';

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
  tombstones: Map<string, { entity: string; id: EntityKey }>;
}

/**
 * Encode one component of an overlay key so the concatenation is injective.
 *
 * The component is written `<tag><length>:<text>`, which is self-delimiting —
 * so no value can forge a component boundary and no separator character is
 * needed at all. The tag distinguishes a `string` from a `number`, because
 * record lookup compares with `===` and therefore treats `'42'` and `42` as
 * different rows; an overlay that conflated them would let one delete hide two
 * records.
 *
 * A length-prefixed encoding is used rather than an escaped separator
 * deliberately: an escape scheme has to be got right in two directions, and a
 * separator embedded in the source has bitten this repository before (M50's
 * ejection key used a raw NUL, which made `grep` skip the file silently).
 *
 * @param value - The component value
 * @returns The self-delimiting encoding
 */
function overlayKeyPart(value: unknown): string {
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'number') {
    const text = String(value);
    return `n${text.length}:${text}`;
  }
  // A column absent from the caller's key object. Tagged distinctly so a
  // partial key can never encode to the same string as a complete one.
  if (value === undefined) return 'u0:';
  const text = String(value);
  return `x${text.length}:${text}`;
}

/**
 * Compose a stable overlay key from an entity name and an {@linkcode EntityKey}.
 *
 * The key must agree with {@linkcode findRecordIndex}, which compares each
 * primary-key column with `===` in the mapping's declared order — so this reads
 * the same columns in the same order, and encodes each component with
 * {@linkcode overlayKeyPart} so that neither a type difference nor a delimiter
 * inside a value can collide.
 *
 * The previous encoding (`entity::scalar`, or `col=value` joined with `|`) had
 * both collisions, and both let ONE delete hide TWO rows inside a transaction
 * and then commit a delete for only one — so an in-transaction read reported a
 * state that never existed. Reproduced before the fix:
 *
 * - scalar `'42'` and `42` both encoded to `W::42`;
 * - `{ a: 'x|b=y', b: 'z' }` and `{ a: 'x', b: 'y|b=z' }` both encoded to
 *   `W::a=x|b=y|b=z`.
 *
 * A scalar and a single-column record naming the same value encode identically
 * — which is correct, because record lookup treats them as the same row.
 *
 * @param entity - Entity name
 * @param id - Primary key value (scalar or composite record)
 * @param keyColumns - The store's primary-key columns, in declared order
 * @returns A stable string key for overlay maps/sets
 * @since 0.1.0
 */
function overlayKey(entity: string, id: EntityKey, keyColumns: readonly string[]): string {
  const head = overlayKeyPart(entity);
  if (typeof id === 'string' || typeof id === 'number') {
    return `${head}${overlayKeyPart(id)}`;
  }
  const record = id as Record<string, string | number>;
  // The mapping's column order, NOT the caller's key order — `findRecordIndex`
  // matches by column, so the two must agree about identity.
  return `${head}${keyColumns.map((column) => overlayKeyPart(record[column])).join('')}`;
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
function findRecordIndexForRecords(
  records: readonly Record<string, unknown>[],
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

/**
 * Find the index of an {@linkcode EntityKey} in the store's own record list.
 *
 * A thin call through {@linkcode findRecordIndexForRecords} with
 * `store.records`. The two used to be separate copies of the same body,
 * differing only in where the list came from — so a change to matching
 * semantics had to be made twice, and the transaction paths (which pass the
 * overlay's effective records) could silently drift from the committed ones.
 *
 * @param store - The entity store to search
 * @param id - The primary key value to match
 * @returns The record index, or `-1` when not found
 * @since 0.1.0
 */
function findRecordIndex(store: EntityStore, id: EntityKey): number {
  return findRecordIndexForRecords(store.records, store, id);
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
      tombstones: new Map(),
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
        // Flush delete tombstones. The ORIGINAL key object is replayed, never
        // a value parsed back out of the overlay's map key: that parser
        // coerced any numeric-looking segment with `Number()`, so a string key
        // such as '42' or '0042' came back as a number and matched no record —
        // the delete then survived commit, or removed the wrong row.
        for (const { entity: ent, id } of overlay.tombstones.values()) {
          const store = this.getStore(ent);
          const idx = findRecordIndex(store, id);
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
      // The overlay's own key for a row, derived from the row's key columns.
      const keyOf = (row: Record<string, unknown>): string => {
        const id = store.primaryKey.length === 1 ? row[store.primaryKey[0]] as EntityKey : (() => {
          const rec: Record<string, string | number> = {};
          for (const c of store.primaryKey) rec[c] = row[c] as string | number;
          return rec;
        })();
        return overlayKey(entity, id, store.primaryKey);
      };
      // Shadows and tombstones apply to EVERY row a transaction can see, not
      // only to committed ones. Buffered creates used to be appended raw, so a
      // row created and then updated in the same transaction read back with its
      // original values — `update()` returned the new record while the next
      // read returned the old one — and a created row that was then deleted
      // stayed visible until commit. Both committed correctly, so the
      // divergence was confined to reads inside the transaction, which is
      // where a caller is least likely to be suspicious of them.
      const applyOverlay = (row: Record<string, unknown>): Record<string, unknown> | null => {
        const key = keyOf(row);
        if (overlay.tombstones.has(key)) return null; // deleted
        return overlay.shadows.get(key)?.record ?? row;
      };
      return store.records
        .concat(overlay.creates.filter((c) => c.entity === entity).map((c) => c.record))
        .map(applyOverlay)
        .filter((r): r is Record<string, unknown> => r !== null);
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

      findPage: (query) => this.findPageInternal(entity, query, effectiveRecords),

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
        overlay.shadows.set(
          overlayKey(entity, id, store.primaryKey),
          { entity, id, record: newRecord },
        );
        return Promise.resolve({ ...newRecord });
      },

      delete: (id) => {
        const store = this.getStore(entity);
        const effective = effectiveRecords();
        const targetIndex = findRecordIndexForRecords(effective, store, id);
        if (targetIndex === -1) return Promise.resolve(false);
        overlay.tombstones.set(overlayKey(entity, id, store.primaryKey), { entity, id });
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
      findPage: (query) =>
        this.findPageInternal(entity, query, () => this.getStore(entity).records),
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

  /**
   * Core `findPage` implementation shared between the non-transactional data
   * source and the transaction overlay. The `getRecords` thunk lets the two
   * callers — the committed store and the per-tx overlay — each supply their
   * visible row set without duplicating the cursor-handling logic.
   *
   * Pipeline:
   * 1. Decode the incoming cursor. When absent, the walk starts at page one.
   *    When malformed, reject by name.
   * 2. When present, verify the sort fingerprint so a cross-sort cursor is
   *    refused rather than served a silently wrong page.
   * 3. Build the portable keyset predicate with {@linkcode keysetPredicate},
   *    conjoin it with the caller's own filter (when present), and apply
   *    `where` / `filter` / `orderBy` in the same order as {@linkcode findAll}.
   * 4. Fetch `limit + 1` rows (the one-extra-row probe): if more than `limit`
   *    are returned there IS a next page and the last returned row yields the
   *    next cursor; otherwise the page is terminal and `nextCursor` is `null`.
   * 5. When a projection is active, the key columns are added to the internal
   *    select so they participate in the probe and are available for cursor
   *    minting; they are stripped from the returned rows so the caller's
   *    projection is what comes back — plan §8 risk.
   *
   * `decoded.orderedValues` carries the value of EVERY ordered field (in
   * `orderBy` order) from the last row of the previous page — not just key
   * column values. This is what {@linkcode keysetPredicate} indexes by
   * position to build the "row after this one" comparison.
   *
   * @param entity - Entity name
   * @param query - Normalized page query (carries `cursor`, `filter`,
   *   `orderBy`, `limit`, and `select`)
   * @param getRecords - Thunk supplying the visible rows at call time
   * @returns A {@linkcode PageResult} carrying `rows` and the `nextCursor`
   * @throws {UnsupportedQueryFeatureError} When the token is malformed or the
   *   fingerprint does not match the current sort
   */
  findPageInternal(
    entity: string,
    query: NormalizedQuery,
    getRecords: () => Record<string, unknown>[],
  ): Promise<PageResult> {
    const store = this.getStore(entity);
    const keyColumns = store.primaryKey;

    // 1. Decode cursor. A missing cursor means start of the walk.
    let decoded: CursorPayload | null = null;
    if (query.cursor !== undefined) {
      decoded = decodeCursor(query.cursor);
      if (decoded === null) {
        return Promise.reject(
          new UnsupportedQueryFeatureError(
            'cursor-pagination',
            'memory',
            `entity '${entity}': malformed cursor token`,
          ),
        );
      }
    }

    // 2. Sort fingerprint guard. A cursor minted under a different sort must be
    //    refused by name rather than served a silently wrong page.
    const fingerprint = sortFingerprint(query.orderBy);
    if (decoded !== null && decoded.sortFingerprint !== fingerprint) {
      return Promise.reject(
        new UnsupportedQueryFeatureError(
          'cursor-pagination',
          'memory',
          `entity '${entity}': cursor fingerprint mismatch — expected '${fingerprint}', ` +
            `got '${decoded.sortFingerprint}'`,
        ),
      );
    }

    // 3. Filter. The caller's `where` FIRST, then the keyset predicate, then
    //    the caller's `filter` — the same three the other read paths apply.
    //
    //    `where` was omitted here while `findAll` applied it, so
    //    `findPage({ where: { role: 'admin' } })` returned every row: a caller
    //    scoping a page by tenant, owner or role received rows outside its own
    //    criteria. Reproduced before the fix, on the public surface.
    let results = getRecords();
    if (query.where && Object.keys(query.where).length > 0) {
      results = results.filter((row) => matchesWhere(row, query.where));
    }
    if (decoded !== null) {
      const predicate = keysetPredicate(
        decoded.orderedValues,
        decoded.keyValues,
        query.orderBy,
        keyColumns,
      );
      results = results.filter((row) => matchesFilter(row, predicate));
    }

    if (query.filter !== undefined) {
      const filter = query.filter;
      results = results.filter((row) => matchesFilter(row, filter));
    }
    results = applyOrderBy(results, resolveKeysetSort(query.orderBy, keyColumns));

    // 4. One-extra-row probe. `limit + 1` rows tells us whether a next page
    //    exists: more than `limit` means there is, and the LAST row mints the
    //    next cursor; otherwise the page is terminal.
    const probeLimit = query.limit > 0 ? query.limit + 1 : -1;
    results = applyPagination(results, 0, probeLimit);

    const hasMore = query.limit > 0 && results.length > query.limit;
    const pageRows = hasMore ? results.slice(0, query.limit) : results;

    // 5. Mint from the UNPROJECTED page rows, then project.
    //
    // The cursor is minted before projection deliberately: `pageRows` still
    // carry every field, so the ordered and key columns are always present
    // even when the caller's `select` names neither. A previous build instead
    // re-ran the whole pipeline with `select` augmented by the key columns, so
    // that a projected row would still carry them — which produced an
    // identical page by construction (in an in-memory store `select` affects
    // only the final projection, never filtering, ordering or pagination) and
    // duplicated every step above. That duplicate is how the keyset-sort fix
    // reached one branch and not the other: the projected path kept ordering
    // by `query.orderBy` while its predicate was expanded over the resolved
    // sort, so a tied page silently skipped or repeated rows whenever the
    // caller passed a non-empty `select`. One path now, so the two cannot
    // disagree again.
    const nextCursor = mintNextCursor(
      hasMore ? pageRows : [],
      query.orderBy,
      keyColumns,
      fingerprint,
      hasMore,
    );

    return Promise.resolve({
      rows: query.select.length > 0
        ? pageRows.map((r) => projectFields(r, query.select) as Record<string, unknown>)
        : pageRows.map((r) => ({ ...r })),
      nextCursor,
    });
  }

  /** @inheritdoc — raw query not supported on memory adapter. */
  rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    return Promise.reject(
      new UnsupportedRawQueryError(
        'memory',
        'The memory adapter does not support raw SQL queries.',
      ),
    );
  }
}

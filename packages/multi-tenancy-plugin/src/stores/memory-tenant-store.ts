/**
 * Zero-dependency in-memory tenant data store.
 *
 * @module
 */
import type { ITenantDataStore, ITenantIsolationStrategy } from '../interfaces/index.ts';
import type { MemoryTenantDataStoreOptions } from '../interfaces/index.ts';

/** Internal partition key type — either a string scope or tenant id. */
type ScopeKey = string;

/** A single row is stored as a mutable record. */
type Row = Record<string, unknown>;

/**
 * A zero-dependency in-memory `ITenantDataStore` that partitions rows by
 * strategy-derived scope (`'column'` → tenantId, `'schema'` → resolved schema,
 * `'database'` → resolved database).
 *
 * When `useIsolation` was never called (bare construction), scope defaults to
 * the raw `tenantId`.
 */
export class MemoryTenantDataStore implements ITenantDataStore {
  /** Top-level: Map<scope, Map<entity, Map<id, Row>>> */
  private readonly store = new Map<ScopeKey, Map<string, Map<string, Row>>>();

  private isolationStrategy: ITenantIsolationStrategy | null = null;

  private readonly generateId: () => string;

  private idCounter = 0;

  constructor(options?: MemoryTenantDataStoreOptions) {
    this.generateId = options?.generateId ?? (() => `${++this.idCounter}`);
  }

  /** Receive the isolation strategy from the plugin's `register()`. */
  useIsolation(strategy: ITenantIsolationStrategy): void {
    this.isolationStrategy = strategy;
  }

  /**
   * Derive the partition scope for a given tenant id using the active strategy.
   * Falls back to the raw tenant id when no strategy is set.
   */
  private deriveScope(tenantId: string): string {
    const s = this.isolationStrategy;
    if (!s) return tenantId;

    switch (s.kind) {
      case 'column':
        return tenantId;
      case 'schema':
        return s.resolveSchema(tenantId);
      case 'database':
        return s.resolveDatabase(tenantId);
    }
  }

  /**
   * Look up an entity map WITHOUT creating it. Read paths use this so that a
   * request carrying an unknown (or attacker-supplied) tenant id never
   * allocates a partition — otherwise arbitrary `x-tenant-id` headers would
   * grow the map unboundedly with zero writes.
   */
  private peekEntityMap(
    scope: ScopeKey,
    entity: string,
  ): Map<string, Row> | undefined {
    return this.store.get(scope)?.get(entity);
  }

  /** Look up an entity map, creating it on demand. Write paths only. */
  private getEntityMap(
    scope: ScopeKey,
    entity: string,
  ): Map<string, Row> {
    let scopeMap = this.store.get(scope);
    if (!scopeMap) {
      scopeMap = new Map();
      this.store.set(scope, scopeMap);
    }
    let entityMap = scopeMap.get(entity);
    if (!entityMap) {
      entityMap = new Map();
      scopeMap.set(entity, entityMap);
    }
    return entityMap;
  }

  /**
   * Copy a stored row on the way out. Rows are handed to callers as detached
   * snapshots: without this, mutating a returned entity would silently rewrite
   * the stored record (and `create` would hand back the live object).
   */
  private static snapshot(row: Row): Row {
    return { ...row };
  }

  findAll<E>(tenantId: string, entity: string): Promise<readonly E[]> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.peekEntityMap(scope, entity);
    if (!entityMap) return Promise.resolve([] as readonly E[]);
    return Promise.resolve(
      Array.from(entityMap.values(), MemoryTenantDataStore.snapshot) as readonly E[],
    );
  }

  findById<E, Id>(tenantId: string, entity: string, id: Id): Promise<E | null> {
    const scope = this.deriveScope(tenantId);
    const row = this.peekEntityMap(scope, entity)?.get(String(id));
    return Promise.resolve((row ? MemoryTenantDataStore.snapshot(row) : null) as E | null);
  }

  find<E>(
    tenantId: string,
    entity: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly E[]> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.peekEntityMap(scope, entity);
    if (!entityMap) return Promise.resolve([] as readonly E[]);

    const results: Row[] = [];
    for (const row of entityMap.values()) {
      if (this.matchesFilter(row, filter)) {
        results.push(MemoryTenantDataStore.snapshot(row));
      }
    }
    return Promise.resolve(results as readonly E[]);
  }

  create<E>(
    tenantId: string,
    entity: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);

    // Determine the id key.
    let idKey: string;
    const rowData = { ...data } as Row;
    if (typeof rowData.id === 'string' || typeof rowData.id === 'number') {
      idKey = String(rowData.id);
    } else {
      idKey = this.generateId();
      rowData.id = idKey;
    }

    // Stamp tenant column if using column strategy.
    if (this.isolationStrategy?.kind === 'column') {
      rowData[this.isolationStrategy.getTenantColumn()] = tenantId;
    }

    entityMap.set(idKey, rowData);
    return Promise.resolve(MemoryTenantDataStore.snapshot(rowData) as E);
  }

  update<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E | null> {
    const scope = this.deriveScope(tenantId);
    const existing = this.peekEntityMap(scope, entity)?.get(String(id));
    if (!existing) return Promise.resolve(null);

    // Ignore an `id` field in the update payload — the key is authoritative;
    // mutating it would create a key/field split that breaks findById.
    const safeData = { ...data };
    delete safeData.id;
    const updated = { ...existing, ...safeData };
    if (typeof updated.id !== 'string' && typeof updated.id !== 'number') {
      updated.id = id;
    }
    // `existing` came from an allocated map, so this lookup cannot allocate.
    this.getEntityMap(scope, entity).set(String(id), updated);
    return Promise.resolve(MemoryTenantDataStore.snapshot(updated) as E);
  }

  delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean> {
    const scope = this.deriveScope(tenantId);
    return Promise.resolve(this.peekEntityMap(scope, entity)?.delete(String(id)) ?? false);
  }

  close(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Check whether a row matches all filter criteria. */
  private matchesFilter(row: Row, filter: Readonly<Record<string, unknown>>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (row[key] !== value) return false;
    }
    return true;
  }
}

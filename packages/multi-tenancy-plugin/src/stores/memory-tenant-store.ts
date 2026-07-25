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

  async findAll<E>(tenantId: string, entity: string): Promise<readonly E[]> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);
    return Array.from(entityMap.values()) as readonly E[];
  }

  async findById<E, Id>(tenantId: string, entity: string, id: Id): Promise<E | null> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);
    return (entityMap.get(String(id)) ?? null) as E | null;
  }

  async find<E>(
    tenantId: string,
    entity: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly E[]> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);

    // If filtering on the tenant column (column strategy), we need to check scope too.
    const results: Row[] = [];
    for (const row of entityMap.values()) {
      if (this.matchesFilter(row, filter)) {
        results.push(row);
      }
    }
    return results as readonly E[];
  }

  async create<E>(
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
    return rowData as E;
  }

  async update<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E | null> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);
    const existing = entityMap.get(String(id));
    if (!existing) return null;

    const updated = { ...existing, ...data };
    if (typeof updated.id !== 'string' && typeof updated.id !== 'number') {
      updated.id = id;
    }
    entityMap.set(String(id), updated);
    return updated as E;
  }

  async delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean> {
    const scope = this.deriveScope(tenantId);
    const entityMap = this.getEntityMap(scope, entity);
    return entityMap.delete(String(id));
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

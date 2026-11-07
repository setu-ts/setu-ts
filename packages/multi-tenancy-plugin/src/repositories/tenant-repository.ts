/**
 * Tenant-scoped repository wrapper.
 *
 * @module
 */
import type { ITenantRepository, WritePrecondition } from '@setu-ts/common';
import type { ITenantDataStore } from '../interfaces/index.ts';

/**
 * Internal wrapper that captures `{ store, tenantId, entity }` and delegates
 * every `ITenantRepository` call to the injected `ITenantDataStore`, threading
 * the captured tenant id and entity name.
 *
 * Not exported from the barrel — consumers hold it as `ITenantRepository<Entity, Id>` from `common`.
 */
export class TenantRepository<Entity, Id = string> implements ITenantRepository<Entity, Id> {
  /**
   * Present only when the store has conditional updates, so absence carries
   * through. `declare`d so no own property exists until the constructor sets it.
   */
  declare readonly updateWhere?: (
    id: Id,
    where: WritePrecondition,
    data: Readonly<Record<string, unknown>>,
  ) => Promise<Entity | null>;

  /** Present only when the store has conditional deletes. */
  declare readonly deleteWhere?: (id: Id, where: WritePrecondition) => Promise<boolean>;

  constructor(
    private readonly store: ITenantDataStore,
    private readonly tenantId: string,
    private readonly entity: string,
  ) {
    // Bound to the store: a class-based store's method reads its own state.
    const updateWhere = store.updateWhere?.bind(store);
    if (updateWhere !== undefined) {
      this.updateWhere = (id, where, data) =>
        updateWhere<Entity, Id>(tenantId, entity, id, where, data);
    }
    const deleteWhere = store.deleteWhere?.bind(store);
    if (deleteWhere !== undefined) {
      this.deleteWhere = (id, where) => deleteWhere<Id>(tenantId, entity, id, where);
    }
  }

  findAll(): Promise<readonly Entity[]> {
    return this.store.findAll<Entity>(this.tenantId, this.entity);
  }

  findById(id: Id): Promise<Entity | null> {
    return this.store.findById<Entity, Id>(this.tenantId, this.entity, id);
  }

  find(filter: Readonly<Record<string, unknown>>): Promise<readonly Entity[]> {
    return this.store.find<Entity>(this.tenantId, this.entity, filter);
  }

  create(data: Readonly<Record<string, unknown>>): Promise<Entity> {
    return this.store.create<Entity>(this.tenantId, this.entity, data);
  }

  update(id: Id, data: Readonly<Record<string, unknown>>): Promise<Entity | null> {
    return this.store.update<Entity, Id>(this.tenantId, this.entity, id, data);
  }

  delete(id: Id): Promise<boolean> {
    return this.store.delete<Id>(this.tenantId, this.entity, id);
  }
}

// deno-lint-ignore-file no-unused-vars

/**
 * Tenant-scoped repository wrapper.
 *
 * @module
 */
import type { ITenantRepository } from '@hono-enterprise/common';
import type { ITenantDataStore } from '../interfaces/index.ts';

/**
 * Internal wrapper that captures `{ store, tenantId, entity }` and delegates
 * every `ITenantRepository` call to the injected `ITenantDataStore`, threading
 * the captured tenant id and entity name.
 *
 * Not exported from the barrel — consumers hold it as `ITenantRepository<Entity, Id>` from `common`.
 */
export class TenantRepository<Entity, Id = string> implements ITenantRepository<Entity, Id> {
  constructor(
    private readonly store: ITenantDataStore,
    private readonly tenantId: string,
    private readonly entity: string,
  ) {}

  async findAll(): Promise<readonly Entity[]> {
    return this.store.findAll<Entity>(this.tenantId, this.entity);
  }

  async findById(id: Id): Promise<Entity | null> {
    return this.store.findById<Entity, Id>(this.tenantId, this.entity, id);
  }

  async find(filter: Readonly<Record<string, unknown>>): Promise<readonly Entity[]> {
    return this.store.find<Entity>(this.tenantId, this.entity, filter);
  }

  async create(data: Readonly<Record<string, unknown>>): Promise<Entity> {
    return this.store.create<Entity>(this.tenantId, this.entity, data);
  }

  async update(id: Id, data: Readonly<Record<string, unknown>>): Promise<Entity | null> {
    return this.store.update<Entity, Id>(this.tenantId, this.entity, id, data);
  }

  async delete(id: Id): Promise<boolean> {
    return this.store.delete<Id>(this.tenantId, this.entity, id);
  }
}

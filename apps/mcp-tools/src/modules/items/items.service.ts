import type { IRuntimeServices } from '@setu-ts/common';
import type {
  ArchiveItemsBody,
  CreateItemsBody,
  ItemsResponse,
  ListItemsQuery,
  UpdateItemsBody,
} from './items.schemas.ts';

/** Creates process-local sample storage owned by one route registration (one app). */
export function createItemsService(): {
  listItems(query: ListItemsQuery): readonly ItemsResponse[];
  getItems(id: string): ItemsResponse | undefined;
  createItems(body: CreateItemsBody, runtime: IRuntimeServices): ItemsResponse;
  updateItems(id: string, body: UpdateItemsBody): ItemsResponse | undefined;
  archiveItems(id: string, body: ArchiveItemsBody): ItemsResponse | undefined;
} {
  // Replace this unbounded demonstration store with a repository before deployment.
  const records = new Map<string, ItemsResponse>();
  return {
    listItems(query) {
      const offset = query.offset ?? 0;
      return [...records.values()]
        .filter(
          (record) =>
            query.archived === undefined || record.archived === (query.archived === 'true'),
        )
        .slice(offset, offset + (query.limit ?? 20));
    },
    getItems(id) {
      return records.get(id);
    },
    createItems(body, runtime) {
      const record = { ...body, id: runtime.uuid(), archived: false };
      records.set(record.id, record);
      return record;
    },
    updateItems(id, body) {
      const current = records.get(id);
      if (current === undefined) return undefined;
      const record = { ...current, ...body, name: body.name ?? current.name, id };
      records.set(id, record);
      return record;
    },
    archiveItems(id, body) {
      const current = records.get(id);
      if (current === undefined) return undefined;
      const record = { ...current, archived: true, reason: body.reason };
      records.set(id, record);
      return record;
    },
  };
}

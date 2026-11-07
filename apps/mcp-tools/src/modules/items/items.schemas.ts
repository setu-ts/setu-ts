import { z } from 'zod';

/** Input for a new items record. */
export const CreateItemsBody = z.object({ name: z.string().trim().min(1).max(120) });
export type CreateItemsBody = z.infer<typeof CreateItemsBody>;
export const UpdateItemsBody = CreateItemsBody.partial();
export type UpdateItemsBody = z.infer<typeof UpdateItemsBody>;
export const ArchiveItemsBody = z.object({ reason: z.string().trim().min(1).max(240) });
export type ArchiveItemsBody = z.infer<typeof ArchiveItemsBody>;
export const ListItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  archived: z.enum(['true', 'false']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListItemsQuery = z.infer<typeof ListItemsQuery>;
export const ItemsParams = z.object({ id: z.string().min(1) });
export type ItemsParams = z.infer<typeof ItemsParams>;
export const ItemsResponse = CreateItemsBody.extend({
  id: z.string(),
  archived: z.boolean(),
  reason: z.string().optional(),
});
export type ItemsResponse = z.infer<typeof ItemsResponse>;
export const ItemsListResponse = z.object({ items: z.array(ItemsResponse) });
export type ItemsListResponse = z.infer<typeof ItemsListResponse>;

/** Startup-validated per-tool rate configuration. */
export const McpToolsConfig = z.object({
  MCP_RATE_MAX: z.coerce.number().int().min(1).max(999_999).default(60),
});

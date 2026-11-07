import { z } from 'zod';

/** One line of an order. */
export const LineItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1).max(10_000),
});
export type LineItem = z.infer<typeof LineItem>;

/** Input for a new orders record. */
export const CreateOrdersBody = z.object({ items: z.array(LineItem).min(1).max(100) });
export type CreateOrdersBody = z.infer<typeof CreateOrdersBody>;
export const ListOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuery>;
export const OrdersParams = z.object({ id: z.string().min(1) });
export type OrdersParams = z.infer<typeof OrdersParams>;
export const OrdersResponse = z.object({
  id: z.string(),
  items: z.array(LineItem),
  totalCents: z.number().int(),
});
export type OrdersResponse = z.infer<typeof OrdersResponse>;
export const OrdersListResponse = z.object({ items: z.array(OrdersResponse) });
export type OrdersListResponse = z.infer<typeof OrdersListResponse>;

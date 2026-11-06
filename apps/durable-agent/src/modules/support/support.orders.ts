import type { IRepository } from '@setu-ts/database-plugin';

/** An order the agent can look up and refund. Amounts are in cents. */
export interface Order {
  readonly id: string;
  readonly customer: string;
  readonly item: string;
  readonly amountCents: number;
}

/** A refund the agent issued, after a person approved it. */
export interface Refund {
  /** The tool call's idempotency key, so one call can only ever write one row. */
  readonly id: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly reason: string;
  readonly runId: string;
  readonly createdAt: number;
}

/** The demonstration orders; `schema.sql` inserts the same three rows. */
export const SEED_ORDERS: readonly Order[] = [
  {
    id: 'A-1001',
    customer: 'Priya Natarajan',
    item: 'Noise-cancelling headphones',
    amountCents: 18900,
  },
  { id: 'A-1002', customer: 'Tomás Ferreira', item: 'Mechanical keyboard', amountCents: 12450 },
  { id: 'A-1003', customer: 'Amara Okafor', item: 'USB-C dock', amountCents: 8999 },
];

/** Repositories the order queries read; the tools pass transaction-scoped ones. */
export interface OrderRepositories {
  readonly orders: IRepository<Order>;
  readonly refunds: IRepository<Refund>;
}

/** An order with what has already been refunded against it. */
export interface OrderSummary extends Order {
  readonly refundedCents: number;
}

/**
 * Reads one order and the total already refunded on it.
 *
 * @param repos - Order and refund repositories
 * @param id - The order id
 * @returns The summary, or `undefined` for an unknown order
 */
export async function orderSummary(
  repos: OrderRepositories,
  id: string,
): Promise<OrderSummary | undefined> {
  const order = await repos.orders.findById(id);
  if (!order) return undefined;
  const refunded = await repos.refunds.findAll({ where: { orderId: id } });
  return { ...order, refundedCents: refunded.reduce((sum, r) => sum + r.amountCents, 0) };
}

import type { IRepository } from '@setu-ts/database-plugin';

/** An order the agent can look up and refund. Amounts are in cents. */
export interface Order {
  readonly id: string;
  /** The demo user who placed the order; only they can ask about it. */
  readonly ownerId: string;
  readonly customer: string;
  readonly item: string;
  readonly amountCents: number;
}

/** A refund the agent issued, after a support lead approved it. */
export interface Refund {
  /**
   * The order id and the refund's number on it (`A-1001#1`, `A-1001#2`, …).
   * Two refunds racing on one order both read the same count and so try the
   * same key: the second insert waits for the first and fails, so they cannot
   * both pass the "not more than is left" check.
   */
  readonly id: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly reason: string;
  readonly runId: string;
  /** The tool call's idempotency key: the call that wrote this row. */
  readonly callKey: string;
  readonly createdAt: number;
}

/**
 * The demo users who approve refunds. A customer can ask for a refund but
 * never approve one, including their own; a lead approves but owns no orders.
 */
export const APPROVERS: readonly string[] = ['lead'];

/** The demonstration orders; `schema.sql` inserts the same three rows. */
export const SEED_ORDERS: readonly Order[] = [
  {
    id: 'A-1001',
    ownerId: 'priya',
    customer: 'Priya Natarajan',
    item: 'Noise-cancelling headphones',
    amountCents: 18900,
  },
  {
    id: 'A-1002',
    ownerId: 'tomas',
    customer: 'Tomás Ferreira',
    item: 'Mechanical keyboard',
    amountCents: 12450,
  },
  {
    id: 'A-1003',
    ownerId: 'amara',
    customer: 'Amara Okafor',
    item: 'USB-C dock',
    amountCents: 8999,
  },
];

/** Repositories the order queries use; the tools pass transaction-scoped ones. */
export interface OrderRepositories {
  readonly orders: IRepository<Order>;
  readonly refunds: IRepository<Refund>;
}

/** An order as the agent and the page see it: never its owner id. */
export interface OrderSummary {
  readonly id: string;
  readonly customer: string;
  readonly item: string;
  readonly amountCents: number;
  readonly refundedCents: number;
  readonly remainingCents: number;
}

/**
 * Summarizes an order with what has been refunded on it.
 *
 * @param repos - Order and refund repositories
 * @param order - The order
 * @returns The summary, and the refunds it was computed from
 */
export async function summarize(
  repos: OrderRepositories,
  order: Order,
): Promise<{ summary: OrderSummary; refunds: readonly Refund[] }> {
  const refunds = await repos.refunds.findAll({ where: { orderId: order.id } });
  const refundedCents = refunds.reduce((sum, r) => sum + r.amountCents, 0);
  return {
    summary: {
      id: order.id,
      customer: order.customer,
      item: order.item,
      amountCents: order.amountCents,
      refundedCents,
      remainingCents: order.amountCents - refundedCents,
    },
    refunds,
  };
}

/**
 * Reads one order the given customer owns. Another customer's order reads as
 * missing, so the agent cannot be talked into acting on it.
 *
 * @param repos - Order and refund repositories
 * @param ownerId - The customer the run belongs to
 * @param id - The order id
 * @returns The order, or `undefined` when it is unknown or someone else's
 */
export async function ownOrder(
  repos: OrderRepositories,
  ownerId: string | null,
  id: string,
): Promise<Order | undefined> {
  const order = await repos.orders.findById(id);
  return order && ownerId !== null && order.ownerId === ownerId ? order : undefined;
}

/** Why {@linkcode refundOrder} refused. */
export type RefundRefusal = 'no-such-order' | 'too-much';

/**
 * Records a refund through the caller's transaction, if the customer owns the
 * order and it has that much left.
 *
 * The refund's key is its number on the order, taken from the refunds just
 * read. A concurrent refund that committed in between used the same number,
 * so this insert fails with a duplicate key and the transaction rolls back:
 * the two can never refund more than the order between them.
 *
 * @param repos - Transaction-scoped order and refund repositories
 * @param ownerId - The customer the run belongs to
 * @param refund - What to refund, without its id
 * @returns The order's summary after the refund, or why nothing was refunded
 * @throws {DuplicateKeyError} When a concurrent refund on the order won
 */
export async function refundOrder(
  repos: OrderRepositories,
  ownerId: string | null,
  refund: Omit<Refund, 'id'>,
): Promise<OrderSummary | RefundRefusal> {
  const order = await ownOrder(repos, ownerId, refund.orderId);
  if (!order) return 'no-such-order';
  const { summary, refunds } = await summarize(repos, order);
  if (refund.amountCents > summary.remainingCents) return 'too-much';
  await repos.refunds.create({ ...refund, id: `${order.id}#${refunds.length + 1}` });
  const refundedCents = summary.refundedCents + refund.amountCents;
  return { ...summary, refundedCents, remainingCents: order.amountCents - refundedCents };
}

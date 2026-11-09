import { Code, ConnectError } from '@connectrpc/connect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery, IServiceRegistry } from '@setu-ts/common';
import { badRequest, serviceUnavailable } from '@setu-ts/exceptions';
import { createBillingClient, type BillingClient } from '../clients/billing.client.ts';
import type {
  CreateOrdersBody,
  ListOrdersQuery,
  OrdersResponse,
} from '../shared/schemas/orders.schemas.ts';

/**
 * Sample storage: replace it with a repository before deploying.
 *
 * This `Map` lives in process memory with no size limit, and the generated
 * routes that write to it are public — anyone who can reach the application can
 * fill it until the process restarts. Add authentication to the routes and a
 * real store before the module serves real traffic.
 */
const records = new Map<string, OrdersResponse>();

/** Lists records with pagination. */
export function listOrders(
  query: ListOrdersQuery = { limit: 20, offset: 0 },
): readonly OrdersResponse[] {
  const offset = query.offset ?? 0;
  return [...records.values()].slice(offset, offset + (query.limit ?? 20));
}

/** Reads one record. */
export function getOrders(id: string): OrdersResponse | undefined {
  return records.get(id);
}

/**
 * Resolves the billing client for a request. A `null` resolve — no billing
 * instance is configured, or discovery has ejected them all — answers `503`; the error carries no upstream
 * detail.
 */
export async function resolveBillingClient(services: IServiceRegistry): Promise<BillingClient> {
  const discovery = services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
  const baseUrl = await discovery.resolveUrl('billing', '/grpc');
  if (baseUrl === null) throw serviceUnavailable('billing is unavailable.');
  return createBillingClient(baseUrl);
}

/**
 * Whether a billing call failed because billing could not be reached in time.
 * A server-side outage, and a refused or reset connection, are `Unavailable` —
 * connect-node's HTTP/2 transport reports a connection failure that way — and a
 * call past the client's deadline is `DeadlineExceeded`. Anything else (`Unknown`
 * from a bug, say) is not an outage and stays a 500.
 */
function isUnreachable(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded)
  );
}

/**
 * Creates an order: quotes the line items from billing and stores the result.
 *
 * `billing` is the module's one external dependency — a test injects a fake.
 * Errors map to the workspace's contract: billing's `InvalidArgument` is a
 * `400`, an unreachable billing is a `503`, and anything else is left to the
 * application's error handler (a `500`).
 */
export async function createOrders(
  body: CreateOrdersBody,
  billing: BillingClient,
): Promise<OrdersResponse> {
  let totalCents: bigint;
  try {
    const quote = await billing.quote({ items: body.items });
    totalCents = quote.totalCents;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.InvalidArgument) {
      throw badRequest('billing rejected the request.');
    }
    if (isUnreachable(error)) throw serviceUnavailable('billing is unavailable.');
    throw error;
  }
  const record: OrdersResponse = {
    id: crypto.randomUUID(),
    items: body.items,
    totalCents: Number(totalCents),
  };
  records.set(record.id, record);
  return record;
}

/**
 * The service's name, which `src/services/index.ts` (CLI-owned) re-exports as the
 * convenience entry for this plain-function service.
 *
 * @returns `'orders'`
 */
export function describeOrders(): string {
  return 'orders';
}

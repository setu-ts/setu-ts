import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { notFound } from '@setu-ts/exceptions';
import { validateBody, validateParams, validateQuery } from '@setu-ts/validation-plugin';
import {
  CreateOrdersBody,
  ListOrdersQuery,
  OrdersListResponse,
  OrdersParams,
  OrdersResponse,
} from '../shared/schemas/orders.schemas.ts';

import {
  createOrders,
  getOrders,
  listOrders,
  resolveBillingClient,
} from '../services/orders.service.ts';

const createBody = validateBody(CreateOrdersBody);
const listQuery = validateQuery(ListOrdersQuery);
const params = validateParams(OrdersParams);

/**
 * Registers the orders routes. Called by the managed index in
 * `src/controllers/index.ts`, which `setu.config.ts` invokes with `app.router`
 * and `app.services`.
 */
export function registerOrdersRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  router.group('/orders', (routes) => {
    routes.get('/', {
      middleware: [listQuery],
      schema: { response: { 200: OrdersListResponse } },
      handler: (ctx) =>
        ctx.response.json({
          items: listOrders(listQuery.value(ctx)),
        }),
    });
    routes.get('/:id', {
      middleware: [params],
      schema: { response: { 200: OrdersResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = getOrders(id);
        if (record === undefined) throw notFound('Orders not found.');
        return ctx.response.json(record);
      },
    });
    // An order total cannot be patched without re-quoting, so the generated
    // PATCH route is removed; POST re-quotes on every create.
    routes.post('/', {
      middleware: [createBody],
      schema: { response: { 201: OrdersResponse } },
      handler: async (ctx) => {
        if (services === undefined) {
          throw new Error('registerOrdersRoutes needs the service registry.');
        }
        const billing = await resolveBillingClient(services);
        return ctx.response.status(201).json(await createOrders(createBody.value(ctx), billing));
      },
    });
  });
}

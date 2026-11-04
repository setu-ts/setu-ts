import { CAPABILITIES, type ILogger, type IRequestContext } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';

import type { Product } from './products.types.ts';
import { PRODUCTS_ENTITY } from './products.seed.ts';

/** What the products module offers to pages and to its API routes. */
export interface ProductsService {
  /** The catalogue, ordered by name. */
  list(): Promise<readonly Product[]>;
}

/**
 * Builds the service for one request.
 *
 * Registered with `requestService` in this module's `index.ts`, so it runs at
 * most once per request and every caller in that request — a page loader
 * through `getService`, an API route through `resolveRequestService` — shares
 * the instance. The request context is here for what is request-bound: the
 * tenant, the principal, `ctx.signal`. A page never receives it.
 *
 * @param ctx - The kernel request context
 * @returns The request's products service
 */
export function productsService(ctx: IRequestContext): ProductsService {
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  return {
    async list() {
      logger.debug('products: listing');
      const products = await ctx.services
        .get<IDatabaseService>(CAPABILITIES.DATABASE)
        .getRepository<Product>(PRODUCTS_ENTITY)
        .findAll();
      return [...products].sort((left, right) => left.name.localeCompare(right.name));
    },
  };
}

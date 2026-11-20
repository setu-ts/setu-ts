import { CAPABILITIES, type ILogger, type IRequestContext } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { conflict } from '@setu-ts/exceptions';

import type { Product, ProductInput } from './products.types.ts';
import { PRODUCTS_ENTITY } from './products.seed.ts';

/** What the products module offers to pages and to its API routes. */
export interface ProductsService {
  /** Parses a posted product, or returns a validation message. */
  parse(value: { readonly name?: unknown; readonly price?: unknown }): ProductInput | string;
  /** The catalogue, ordered by name. */
  list(): Promise<readonly Product[]>;
  /** Adds a product; refuses a name already in the catalogue with 409. */
  create(input: ProductInput): Promise<Product>;
}

/**
 * Builds the service for one request.
 *
 * Registered with `requestService` in this module's `index.ts`, so it runs at
 * most once per request and every caller in that request — a page loader or
 * action through `getService`, an API route through `resolveRequestService` —
 * shares the instance. The request context is here for what is request-bound:
 * the tenant, the principal, `ctx.signal`. A page never receives it.
 *
 * @param ctx - The kernel request context
 * @returns The request's products service
 */
export function productsService(ctx: IRequestContext): ProductsService {
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  const repository = () =>
    ctx.services
      .get<IDatabaseService>(CAPABILITIES.DATABASE)
      .getRepository<Product>(PRODUCTS_ENTITY);
  const list = async (): Promise<readonly Product[]> => {
    const products = await repository().findAll();
    return [...products].sort((left, right) => left.name.localeCompare(right.name));
  };
  return {
    parse: (value) => {
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      if (name.length === 0) return 'A non-empty name is required.';
      // A decimal amount with at most two places: Number() alone reads '' as 0 and '0x10' as 16.
      const price = typeof value.price === 'string' ? value.price.trim() : '';
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(price)) return 'The price must be an amount such as 4.99.';
      return { name, priceCents: Math.round(Number(price) * 100) };
    },
    list() {
      logger.debug('products: listing');
      return list();
    },
    async create(input) {
      const taken = (await list()).some(
        (product) => product.name.toLowerCase() === input.name.toLowerCase(),
      );
      // A caller error: pageAction shows its detail in the form, an API route answers 409.
      // Check-then-write is not atomic: a real store needs a unique index on the name,
      // with its duplicate-key error mapped to this same conflict.
      if (taken) throw conflict(`A product named ${input.name} already exists.`);
      return repository().create({ id: crypto.randomUUID(), ...input });
    },
  };
}

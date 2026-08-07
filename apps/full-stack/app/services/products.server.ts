import type { IDatabaseService, IRepository } from '@hono-enterprise/database-plugin';
import type { AppLoadContext } from '~/lib/load-context.ts';
import type { Product } from '~/models/product.ts';
import { getDatabase, getLogger } from '~/config/services.server.ts';

/**
 * The entity name both the seed and the read use.
 *
 * One constant, because a repository is addressed by string: a typo in either
 * place would produce an empty catalogue rather than an error.
 */
export const PRODUCTS_ENTITY = 'products';

/**
 * The catalogue the example starts with.
 *
 * Deliberately NOT rendered from here. The route renders whatever the
 * repository returns, so the page is evidence that a write went through the
 * database capability and came back out — which a literal in a component could
 * never be. `smoke.ts` asserts exactly that round trip.
 */
const INITIAL_PRODUCTS: readonly Product[] = [
  { id: 'p-1', name: 'Standard plan', priceCents: 4900 },
  { id: 'p-2', name: 'Premium plan', priceCents: 9900 },
];

/**
 * Writes the initial catalogue through the database capability.
 *
 * Takes the service rather than a request context because seeding is startup
 * wiring, not a request path: `main.ts` and `smoke.ts` resolve it from the
 * application's own registry after `start()`.
 *
 * @param database - The service registered under `CAPABILITIES.DATABASE`
 * @returns The rows as persisted
 */
export async function seedProducts(database: IDatabaseService): Promise<readonly Product[]> {
  const repository: IRepository<Product> = database.getRepository<Product>(PRODUCTS_ENTITY);
  const created: Product[] = [];
  for (const product of INITIAL_PRODUCTS) {
    created.push(await repository.create(product));
  }
  return created;
}

/**
 * Reads the catalogue for the current request.
 *
 * The service layer owns talking to the outside world. It is given the request
 * context rather than reaching for a module-level singleton, so a test can
 * drive it with a plain object and two concurrent requests can never share a
 * connection they did not ask for.
 *
 * @param context - The React Router request context
 * @returns Every product, in insertion order
 */
export async function listProducts(context: AppLoadContext): Promise<readonly Product[]> {
  getLogger(context).debug('products: listing');

  return await getDatabase(context)
    .getRepository<Product>(PRODUCTS_ENTITY)
    .findAll();
}

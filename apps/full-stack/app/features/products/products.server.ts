import type { AppLoadContext } from '~/lib/load-context.ts';
import type { Product } from '~/models/product.ts';
import { listProducts } from '~/services/products.server.ts';

/** What the products route renders. */
export interface ProductsView {
  /** The catalogue, ordered for display. */
  readonly products: readonly Product[];
  /** Total number of products, for the header. */
  readonly total: number;
}

/**
 * The feature layer: use-case logic a route can call in one line.
 *
 * Routes stay thin (parse the request, call this, render), services stay
 * ignorant of presentation, and this is where the two meet.
 *
 * @param context - The React Router request context
 * @returns The view model for the products page
 */
export async function buildProductsView(context: AppLoadContext): Promise<ProductsView> {
  const products = await listProducts(context);
  return {
    products: [...products].sort((left, right) => left.name.localeCompare(right.name)),
    total: products.length,
  };
}

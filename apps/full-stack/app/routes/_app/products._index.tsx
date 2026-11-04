import { useLoaderData } from 'react-router';
import { getService } from '@setu-ts/react-router-plugin';

import type { AppLoadContext } from '~/lib/load-context.ts';
import type { Product } from '~kernel/modules/products/products.types.ts';
import { PRODUCTS } from '~kernel/modules/products/products.token.ts';

/**
 * Loads the view on the server.
 *
 * getService binds the products module to the current kernel request, so the
 * loader uses the same business logic as GET /api/products. Only the module's
 * token is imported by value; its implementation stays under src/.
 *
 * Everything rendered below came out of the database capability. That is the
 * point of this example, and `smoke.ts` asserts it by seeding a row and then
 * looking for it in this page's HTML.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  const products = await getService(context, PRODUCTS).list();
  return { products, total: products.length };
}

/** Formats a price in minor units for display. */
function formatPrice(product: Product): string {
  return `$${(product.priceCents / 100).toFixed(2)}`;
}

export default function ProductsRoute() {
  const { products, total } = useLoaderData<typeof loader>();

  return (
    <section>
      <h1>Products ({total})</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            {product.name} — {formatPrice(product)}
          </li>
        ))}
      </ul>
    </section>
  );
}

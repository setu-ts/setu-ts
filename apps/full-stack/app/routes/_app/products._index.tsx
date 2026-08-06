import { useLoaderData } from 'react-router';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { buildProductsView } from '~/features/products/products.server.ts';
import { formatPrice } from '~/models/product.ts';

/**
 * Loads the view on the server.
 *
 * The request context carries the framework services `honoe.config.ts` put
 * there, so the logger and database are reachable without a module-level
 * singleton or a second DI container — and without importing a framework
 * package into a module that also ships to the browser.
 *
 * Everything rendered below came out of the database capability. That is the
 * point of this example, and `smoke.ts` asserts it by seeding a row and then
 * looking for it in this page's HTML.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  return await buildProductsView(context);
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

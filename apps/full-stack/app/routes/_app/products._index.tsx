import { useLoaderData } from 'react-router';
import { getService } from '@setu-ts/react-router-plugin';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCurrentUser } from '~/server/session.server.ts';
import { requireUser } from '~/server/require-user.server.ts';
import type { Product } from '~kernel/modules/products/products.types.ts';
import { PRODUCTS } from '~kernel/modules/products/products.token.ts';

/**
 * Route middleware: runs before the loader, and sends a visitor who is not
 * signed in to /login. See `app/server/require-user.server.ts` for how this
 * layer differs from the kernel middleware `setu generate middleware` writes.
 */
export const middleware = [requireUser];

/**
 * Loads the page on the server from the products kernel module.
 *
 * `getService` resolves the module's service for THIS request — the same
 * instance `GET /api/products` uses — without a module-level singleton and
 * without importing kernel code by value: the type and the token are all a
 * page imports from `~kernel/*`.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  // Set by the route middleware above; never null here, because the middleware
  // redirects before the loader runs when there is no user.
  const user = getCurrentUser(context);
  const products = await getService(context, PRODUCTS).list();
  return { products, total: products.length, signedInAs: user.email };
}

/** Formats a price in minor units for display. */
function formatPrice(product: Product): string {
  return `$${(product.priceCents / 100).toFixed(2)}`;
}

export default function ProductsRoute() {
  const { products, total, signedInAs } = useLoaderData<typeof loader>();

  return (
    <Card>
      <CardContent className="grid gap-4">
        <h1 className="text-2xl font-semibold">Products ({total})</h1>
        <p className="text-muted-foreground">Signed in as {signedInAs}</p>
        <ul className="list-disc space-y-1 pl-5">
          {products.map((product) => (
            <li key={product.id}>
              {product.name} — {formatPrice(product)}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

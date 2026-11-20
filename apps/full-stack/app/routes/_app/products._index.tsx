import { Form, redirect, useActionData, useLoaderData } from 'react-router';
import { getService, pageAction } from '@setu-ts/react-router-plugin';

import { Button } from '~/components/ui/button.tsx';
import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCsrfToken, getCurrentUser } from '~/server/session.server.ts';
import { requireUser } from '~/server/require-user.server.ts';
import type { Product } from '~kernel/modules/products/products.types.ts';
import { PRODUCTS } from '~kernel/modules/products/products.token.ts';

/**
 * Route middleware: runs before the loader and the action, and sends a visitor
 * who is not signed in to /login. See `app/server/require-user.server.ts` for
 * how this layer differs from the kernel middleware `setu generate middleware`
 * writes.
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
  return {
    products,
    total: products.length,
    signedInAs: user.email,
    csrfToken: getCsrfToken(context),
  };
}

/**
 * Adds a product from the form, through the same service as the loader.
 *
 * The page writes through this action, never through `/api/products`. A
 * validation message or a refusal (a duplicate name is a 409 `conflict` in the
 * service) comes back to the form; a fault goes to the error boundary. On
 * success the redirect reloads the list, so a reload does not post again.
 */
export async function action({ request, context }: { request: Request; context: AppLoadContext }) {
  const form = await request.formData();
  const products = getService(context, PRODUCTS);
  const input = products.parse({ name: form.get('name'), price: form.get('price') });
  if (typeof input === 'string') return { error: input };
  const result = await pageAction('create', () => products.create(input));
  return result.ok ? redirect('/products', 303) : { error: result.error };
}

/** Formats a price in minor units for display. */
function formatPrice(product: Product): string {
  return `$${(product.priceCents / 100).toFixed(2)}`;
}

export default function ProductsRoute() {
  const { products, total, signedInAs, csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Products ({total})</h1>
          {/* A resource route: a plain link, so the browser downloads the file. */}
          <a href="/products/export" download className="text-sm underline underline-offset-4">
            Download CSV
          </a>
        </div>
        <p className="text-muted-foreground">Signed in as {signedInAs}</p>
        <ul className="list-disc space-y-1 pl-5">
          {products.map((product) => (
            <li key={product.id}>
              {product.name} — {formatPrice(product)}
            </li>
          ))}
        </ul>
        <Form method="post" className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <label className="grid gap-2 text-sm font-medium">
            Name
            <input
              name="name"
              required
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Price
            <input
              name="price"
              type="number"
              min="0"
              step="0.01"
              required
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs"
            />
          </label>
          <Button type="submit">Add product</Button>
        </Form>
        {actionData?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {actionData.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

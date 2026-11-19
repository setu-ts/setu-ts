import { getService, serviceCall } from '@setu-ts/react-router-plugin';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { requireUser } from '~/server/require-user.server.ts';
import { PRODUCTS } from '~kernel/modules/products/products.token.ts';

/** The download is behind sign-in, like the page that links to it. */
export const middleware = [requireUser];

/** Quotes one CSV field (RFC 4180): quotes doubled, and quotes around every field. */
function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * A resource route: it has no component, so React Router returns this loader's
 * `Response` as is. `serviceCall` keeps a service refusal's status (a Problem
 * Details response) instead of answering 500; a fault stays a fault.
 */
export async function loader({ request, context }: { request: Request; context: AppLoadContext }) {
  const products = await serviceCall(request, () => getService(context, PRODUCTS).list());
  const rows = [
    ['id', 'name', 'price'],
    ...products.map((product) => [product.id, product.name, (product.priceCents / 100).toFixed(2)]),
  ];
  return new Response(rows.map((row) => row.map(csvField).join(',')).join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="products.csv"',
      'cache-control': 'private, no-store',
    },
  });
}

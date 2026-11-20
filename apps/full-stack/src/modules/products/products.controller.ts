import { type IRouterApi, type IServiceRegistry, resolveRequestService } from '@setu-ts/common';

import { PRODUCTS } from './products.token.ts';

/**
 * The products API, under `/api` so a kernel route never shadows a page.
 *
 * Resolves the same request-bound service the products page reads with
 * `getService`, so the page and the API cannot disagree.
 *
 * For callers outside the app: the products page reads through its loader and
 * writes through its action, never through these routes.
 *
 * Not behind sign-in: the page's `requireUser` guard covers the page only.
 * Add authentication here before these routes serve real data.
 */
export function registerProductsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('/api/products', (routes) => {
    routes.get('/', async (ctx) => {
      const service = resolveRequestService(ctx, PRODUCTS);
      return ctx.response.json({ items: await service.list() });
    });
  });
}

/**
 * The kernel module the `full-stack` template ships (M130 §3.4): the products
 * example as `src/modules/products/`, so business logic lives in the kernel and
 * one request-bound service feeds both the page and `GET /api/products`.
 *
 * The two managed indexes are rendered by the same functions `setu sync` and
 * `setu g module` use, so the scaffolded files and every regeneration of them
 * cannot drift apart. The module's index registers its service because the
 * module-service family admits `products.token.ts` (option A).
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { deriveNames } from '../utils/names.ts';
import {
  MODULE_SERVICE_ARTIFACTS,
  renderFunctionalModuleBarrel,
  renderFunctionalModuleIndex,
} from '../seams/modules.ts';

/** The template's one module. */
export const FULL_STACK_EXAMPLE_MODULE = 'products';

const productsTypes = `/**
 * The products module's data. Plain types, safe to import from a page with
 * \`import type\` through the \`~kernel/*\` alias.
 */

/** A product in the catalogue. */
export interface Product {
  /** Stable identifier. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Price in minor units. */
  readonly priceCents: number;
}
`;

const productsService = `import { CAPABILITIES, type ILogger, type IRequestContext } from '@setu-ts/common';

import type { Product } from './products.types.ts';

/** What the products module offers to pages and to its API routes. */
export interface ProductsService {
  /** The catalogue, ordered by name. */
  list(): Promise<readonly Product[]>;
}

/**
 * Builds the service for one request.
 *
 * Registered with \`requestService\` in this module's \`index.ts\`, so it runs at
 * most once per request and every caller in that request — a page loader
 * through \`getService\`, an API route through \`resolveRequestService\` — shares
 * the instance. The request context is here for what is request-bound: the
 * tenant, the principal, \`ctx.signal\`. A page never receives it.
 *
 * @param ctx - The kernel request context
 * @returns The request's products service
 */
export function productsService(ctx: IRequestContext): ProductsService {
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  return {
    async list() {
      logger.debug('products: listing');
      // Replace with a repository read. Static data keeps the skeleton runnable.
      const products: readonly Product[] = await Promise.resolve([
        { id: 'p-1', name: 'Standard plan', priceCents: 4900 },
        { id: 'p-2', name: 'Premium plan', priceCents: 9900 },
      ]);
      return [...products].sort((left, right) => left.name.localeCompare(right.name));
    },
  };
}
`;

const productsToken = `import { serviceToken } from '@setu-ts/common';

import type { ProductsService } from './products.service.ts';

/**
 * The products service's token.
 *
 * Pages import this module by value, so it must hold nothing else: its only
 * value import is \`serviceToken\`, and the service is named as a type, which
 * the build erases. \`setu check\` lets a page import a \`*.token.ts\` module and
 * refuses every other value import from \`~kernel/*\` (setu.E017).
 */
export const PRODUCTS = serviceToken<ProductsService>('module.products');
`;

const productsController = `import { type IRouterApi, type IServiceRegistry, resolveRequestService } from '@setu-ts/common';

import { PRODUCTS } from './products.token.ts';

/**
 * The products API, under \`/api\` so a kernel route never shadows a page.
 *
 * Resolves the same request-bound service the products page reads with
 * \`getService\`, so the page and the API cannot disagree.
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
`;

/**
 * Every file of the shipped module, including both managed indexes.
 *
 * @returns The module's files, in write order
 */
export function fullStackModuleFiles(): readonly GeneratedFile[] {
  const dir = `src/modules/${FULL_STACK_EXAMPLE_MODULE}`;
  return [
    { path: `${dir}/products.types.ts`, contents: productsTypes },
    { path: `${dir}/products.service.ts`, contents: productsService },
    { path: `${dir}/products.token.ts`, contents: productsToken },
    { path: `${dir}/products.controller.ts`, contents: productsController },
    {
      path: `${dir}/index.ts`,
      managed: true,
      contents: renderFunctionalModuleIndex(deriveNames(FULL_STACK_EXAMPLE_MODULE), {
        controller: [FULL_STACK_EXAMPLE_MODULE],
        [MODULE_SERVICE_ARTIFACTS]: [FULL_STACK_EXAMPLE_MODULE],
      }),
    },
    {
      path: 'src/modules/index.ts',
      managed: true,
      contents: renderFunctionalModuleBarrel([FULL_STACK_EXAMPLE_MODULE]),
    },
  ];
}

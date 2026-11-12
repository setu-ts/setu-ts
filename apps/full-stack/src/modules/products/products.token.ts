import { requestServiceToken } from '@setu-ts/common';

import type { ProductsService } from './products.service.ts';

/**
 * The products service's request-bound token.
 *
 * Pages import this module by value, so it must hold nothing else: its only
 * value import is `requestServiceToken`, and the service is named as a type, which
 * the build erases. `setu check` lets a page import a `*.token.ts` module and
 * refuses every other value import from `~kernel/*` (setu.E017).
 */
export const PRODUCTS = requestServiceToken<ProductsService>('module.products');

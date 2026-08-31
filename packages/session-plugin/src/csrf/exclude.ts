/**
 * Shared form-CSRF path exclusion matching.
 *
 * The middleware and {@linkcode verifyCsrfToken} use this one implementation
 * so an action verifying inline cannot disagree with the global policy.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import type { CsrfFormOptions } from '../options.ts';

/** Whether an explicit path exclusion matches this request. */
export function isCsrfExcluded(
  ctx: IRequestContext,
  exclude: CsrfFormOptions['exclude'],
): boolean {
  for (const entry of exclude ?? []) {
    if (typeof entry === 'string') {
      if (entry === ctx.request.path) return true;
      continue;
    }
    entry.lastIndex = 0;
    if (entry.test(ctx.request.path)) return true;
  }
  return false;
}

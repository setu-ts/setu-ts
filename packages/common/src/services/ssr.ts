/**
 * SSR service contract — used by the React Router plugin to render an SSR
 * document from a kernel request context.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, IRequestContext } from '../http.ts';

/**
 * Service contract for server-side rendering (SSR).
 *
 * Registered by the React Router plugin under `CAPABILITIES.SSR`.  The single
 * {@linkcode render} method receives the kernel's request context, delegates to
 * the React Router request handler, and writes the resulting web `Response` back
 * through `IResponse` (streaming or buffered).
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@hono-enterprise/common';
 *
 * const ssr = ctx.services.get<ISsrService>(CAPABILITIES.SSR);
 * const result = await ssr.render(ctx);
 * return result;
 * ```
 * @since 0.1.0
 */
export interface ISsrService {
  /**
   * Renders an SSR document for the given request context.
   *
   * Bridges the kernel {@linkcode IRequestContext} into a web-standard `Request`,
   * invokes the React Router request handler, maps the resulting web `Response`
   * back onto `ctx.response` (status, headers, body), and returns the
   * {@linkcode HandlerResult} the route handler should return.
   *
   * @param ctx - The current kernel request context
   * @returns A promise that resolves to the handler result
   * @since 0.1.0
   */
  render(ctx: IRequestContext): Promise<HandlerResult>;
}

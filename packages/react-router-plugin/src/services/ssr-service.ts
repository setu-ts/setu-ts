/**
 * SsrService — implements `ISsrService` under `CAPABILITIES.SSR`.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, IRequestContext, IRuntimeServices, LoadContextFunction } from '@hono-enterprise/common';
import type { ISsrService } from '@hono-enterprise/common';
import type { SsrRequestHandler } from '../interfaces/index.ts';
import { bridgeRequestToRR } from '../handler/request-bridge.ts';

/**
 * Implements {@linkcode ISsrService}.
 *
 * Holds the resolved RR request handler and the optional custom `getLoadContext`,
 * and delegates `render()` to the request bridge.
 *
 * @since 0.1.0
 */
export class SsrService implements ISsrService {
  readonly #handler: SsrRequestHandler;
  readonly #getLoadContext: LoadContextFunction | undefined;
  readonly #runtime: IRuntimeServices;

  /**
   * @param handler - The resolved RR request handler
   * @param getLoadContext - Optional custom loadContext builder
   * @param runtime - Runtime services (for abort signal and fs)
   * @since 0.1.0
   */
  constructor(
    handler: SsrRequestHandler,
    getLoadContext: LoadContextFunction | undefined,
    runtime: IRuntimeServices,
  ) {
    this.#handler = handler;
    this.#getLoadContext = getLoadContext;
    this.#runtime = runtime;
  }

  /**
   * Renders an SSR document for the given request context.
   *
   * @param ctx - The kernel request context
   * @returns A promise resolving to the handler result
   * @since 0.1.0
   */
  async render(ctx: IRequestContext): Promise<HandlerResult> {
    return bridgeRequestToRR(ctx, this.#handler, this.#getLoadContext, this.#runtime);
  }
}

/**
 * SsrService — implements `ISsrService` under `CAPABILITIES.SSR`.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, ISsrService } from '@hono-enterprise/common';
import type {
  IRequestContext,
  LoadContextFunction,
  SsrRequestHandler,
} from '../interfaces/index.ts';
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

  /**
   * @param handler - The resolved RR request handler
   * @param getLoadContext - Optional custom loadContext builder
   * @since 0.1.0
   */
  constructor(
    handler: SsrRequestHandler,
    getLoadContext: LoadContextFunction | undefined,
  ) {
    this.#handler = handler;
    this.#getLoadContext = getLoadContext;
  }

  /**
   * Renders an SSR document for the given request context.
   *
   * @param ctx - The kernel request context
   * @returns A promise resolving to the handler result
   * @since 0.1.0
   */
  async render(ctx: IRequestContext): Promise<HandlerResult> {
    const result = await bridgeRequestToRR(
      ctx,
      this.#handler,
      this.#getLoadContext,
    );
    return result;
  }
}

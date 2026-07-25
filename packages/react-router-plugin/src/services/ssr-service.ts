/**
 * SsrService — implements `ISsrService` under `CAPABILITIES.SSR`.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, ISsrService } from '@hono-enterprise/common';
import type {
  IRequestContext,
  PopulateLoadContext,
  RouterLoadContext,
  SsrRequestHandler,
} from '../interfaces/index.ts';
import { bridgeRequestToRR } from '../handler/request-bridge.ts';

/**
 * Implements {@linkcode ISsrService}.
 *
 * Holds the resolved RR request handler, the factory for its per-request
 * context provider, and the optional `populateLoadContext` hook, and delegates
 * `render()` to the request bridge.
 *
 * @since 0.1.0
 */
export class SsrService implements ISsrService {
  readonly #handler: SsrRequestHandler;
  readonly #createLoadContext: () => RouterLoadContext;
  readonly #populateLoadContext: PopulateLoadContext | undefined;

  /**
   * @param handler - The resolved RR request handler
   * @param createLoadContext - Factory for the per-request context provider,
   *   sourced from the same `react-router` module as `handler`
   * @param populateLoadContext - Optional hook adding app values to the context
   * @since 0.1.0
   */
  constructor(
    handler: SsrRequestHandler,
    createLoadContext: () => RouterLoadContext,
    populateLoadContext: PopulateLoadContext | undefined,
  ) {
    this.#handler = handler;
    this.#createLoadContext = createLoadContext;
    this.#populateLoadContext = populateLoadContext;
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
      this.#createLoadContext,
      this.#populateLoadContext,
    );
    return result;
  }
}

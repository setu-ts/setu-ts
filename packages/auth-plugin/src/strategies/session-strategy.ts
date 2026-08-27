/**
 * Session authentication strategy.
 *
 * Reads the session cookie through `ISessionService.fromHeaders` and maps the
 * opened {@linkcode SessionView} to a principal through the caller-supplied
 * `toPrincipal` callback. Internal to the plugin: configured through
 * `AuthPluginOptions.session`, never barrel-exported.
 *
 * @module
 */

import type { IPrincipal, IRequest, ISessionService, SessionView } from '@setu-ts/common';

/**
 * Options accepted by {@linkcode SessionStrategy}.
 */
export interface SessionStrategyOptions {
  /** The session service that opens the cookie (resolved from `ctx.services`). */
  readonly sessionService: ISessionService;
  /**
   * Maps an opened session to the principal it carries. Return `null` when the
   * session holds no identity — the strategy then yields and the chain
   * continues.
   */
  readonly toPrincipal: (view: SessionView) => IPrincipal | null;
}

/**
 * Session authentication strategy.
 *
 * The interface and the class share this module because `SessionStrategy` is
 * the strategy's own type: a same-named class and interface merge in one
 * module, but the same names cannot be imported from two modules at once.
 *
 * `authenticate` returns `null` when the request carries no usable session
 * (absent cookie, unopenable envelope, expired, or revoked) or when
 * `toPrincipal` says the session carries no identity — in both cases the
 * strategy chain continues with the next strategy.
 */
export class SessionStrategy implements SessionStrategy {
  /** Strategy name for identification. */
  readonly name = 'session';
  private readonly sessionService: ISessionService;
  private readonly toPrincipal: (view: SessionView) => IPrincipal | null;

  constructor(options: SessionStrategyOptions) {
    this.sessionService = options.sessionService;
    this.toPrincipal = options.toPrincipal;
  }

  /**
   * Open the session from the request's headers and map it to a principal.
   *
   * @param request - The incoming request
   * @returns The authenticated principal, or `null` when no session opened or
   *   `toPrincipal` returned `null`
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const view = await this.sessionService.fromHeaders(request.headers);
    if (view === null) {
      return null;
    }
    return this.toPrincipal(view);
  }
}

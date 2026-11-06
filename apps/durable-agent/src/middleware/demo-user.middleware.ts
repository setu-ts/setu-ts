import type { MiddlewareFunction } from '@setu-ts/common';
import { badRequest } from '@setu-ts/exceptions';

/**
 * Where this middleware sits in the pipeline. Lower runs earlier, so lower is
 * outermost; `500` is the framework default.
 *
 * Change it HERE, not in `src/middleware/index.ts` — the CLI regenerates that barrel
 * from this constant, so an edit there is lost on the next generate.
 *
 * For reference, the framework's own middleware occupy 0 (error handler), 20
 * (metrics), 30 (telemetry), 40 (tenant resolution), 100 (request logging),
 * 120–325 (HTTP security, session, authentication and form CSRF). Keep a value
 * above 0, so an installed error handler still formats what this middleware
 * throws.
 */
export const DEMO_USER_MIDDLEWARE_PRIORITY = 500;

/** The identity a request without an `x-demo-user` header acts as: the customer who owns order A-1001. */
export const DEFAULT_DEMO_USER = 'priya';

const DEMO_USER = /^[a-z0-9-]{1,32}$/;

/**
 * Creates the demo-user middleware: DEMONSTRATION ONLY. It trusts the
 * `x-demo-user` request header as the caller's identity, so anyone can be
 * anyone. It exists so the example can show that a run belongs to the person
 * who started it — another user gets a 404 — without an identity provider.
 * Replace it with `AuthPlugin` (or your own authentication) before the
 * application serves anyone but you.
 *
 * A malformed header is refused with `400` before any route runs.
 *
 * Added for you through the `GENERATED_MIDDLEWARE` barrel in
 * `src/middleware/index.ts`, which `setu.config.ts` walks — so this module needs no
 * further wiring.
 *
 * @returns The middleware function
 */
export function demoUserMiddleware(): MiddlewareFunction {
  return async (ctx, next) => {
    const id = ctx.request.headers.get('x-demo-user') ?? DEFAULT_DEMO_USER;
    // Refused here, for every route: a request must never reach a handler
    // without the identity it claimed.
    if (!DEMO_USER.test(id))
      throw badRequest('x-demo-user must be 1-32 lowercase letters, digits or dashes.');
    ctx.request.user = { id };
    await next();
  };
}

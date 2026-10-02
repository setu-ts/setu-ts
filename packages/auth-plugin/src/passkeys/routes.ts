/**
 * The four passkey ceremony routes (plan §3.6), registered under
 * `<signIn.basePath>/passkeys`. Internal: registered by `AuthPlugin` when its
 * `signIn.passkeys` option is configured.
 *
 * All four routes are `POST` with JSON bodies, so with the session plugin's
 * form CSRF configured the browser's `fetch` must send the header token; the
 * README's client snippet does, and the route tests pin both the 403 without
 * it and the success with it. The ceremony binds each response to the origin,
 * so a cross-site POST cannot produce a valid assertion — but the CSRF check
 * is still what stops a cross-site POST from running one at all.
 *
 * Failure handling is fixed by construction, following the sign-in routes'
 * middleware/handler split: the ceremony runs as route middleware, a refusal
 * is written through the error responder with one fixed reason code (and
 * short-circuits without `next()`), and the handler runs only for a success —
 * because the responder seam writes a response without producing the
 * `HandlerResult` a route handler must return.
 *
 * @module
 */

import type { IRequestContext, IRouterApi, RouteDefinition } from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';
import type { PasskeyCeremonies, PasskeyRefusal } from './ceremonies.ts';

/** The route prefix under the sign-in base path. */
const PASSKEYS_PREFIX = '/passkeys';

/** The state key carrying a success body from the middleware to the handler. */
const RESULT_STATE_KEY = 'auth-plugin:passkey-result';

/** The status a refused ceremony answers with, per refusal class. */
const REFUSAL_STATUS: Readonly<Record<PasskeyRefusal, number>> = {
  malformed: 400,
  'ceremony-type': 400,
  'challenge-missing': 400,
  'challenge-used': 400,
  'origin-refused': 400,
  'cross-origin': 400,
  'rp-id-mismatch': 400,
  'flags-refused': 400,
  'algorithm-refused': 400,
  'credential-duplicate': 409,
  'credential-unknown': 400,
  'user-handle-mismatch': 400,
  'wrong-principal': 403,
  'pending-missing': 400,
  'signature-invalid': 400,
  'counter-refused': 400,
  'principal-refused': 403,
  'sign-in-required': 401,
};

/** The titles the responder writes beside each status. */
function statusTitle(status: number): string {
  if (status === 401) {
    return 'Unauthorized';
  }
  if (status === 403) {
    return 'Forbidden';
  }
  if (status === 409) {
    return 'Conflict';
  }
  return 'Bad Request';
}

/** Deps for {@linkcode registerPasskeyRoutes}. */
export interface PasskeyRouteDeps {
  /** Where the routes are registered. */
  readonly router: IRouterApi;
  /** The sign-in base path the passkey prefix hangs off. */
  readonly basePath: string;
  /** The ceremonies the routes adapt. */
  readonly ceremonies: PasskeyCeremonies;
}

/**
 * Wraps a ceremony as a route: the ceremony runs in middleware and stores its
 * success body in {@linkcode RESULT_STATE_KEY}; a refusal is written through
 * the error responder and short-circuits without `next()`, so the handler —
 * and everything downstream of it — never runs for a failed ceremony.
 */
function ceremonyRoute(
  run: (ctx: IRequestContext) => Promise<PasskeyRefusal | null>,
): RouteDefinition {
  return {
    middleware: [async (ctx, next) => {
      const refusal = await run(ctx);
      if (refusal !== null) {
        const status = REFUSAL_STATUS[refusal];
        respondWithError(ctx, { status, title: statusTitle(status), detail: refusal });
        return;
      }
      await next();
    }],
    handler: (ctx) => ctx.response.json(ctx.state.get(RESULT_STATE_KEY)),
  };
}

/**
 * Parses the request's JSON body, resolving `null` for a malformed or absent
 * body: the ceremonies answer a malformed body with the same fixed shape as
 * every other refusal, rather than a thrown 400 whose message quotes it.
 */
async function readJsonBody(ctx: IRequestContext): Promise<unknown> {
  try {
    return await ctx.request.json();
  } catch {
    return null;
  }
}

/**
 * Registers the four passkey routes (plan §3.6):
 *
 * - `POST <basePath>/passkeys/register/options` — requires a signed-in principal
 * - `POST <basePath>/passkeys/register/verify` — requires a signed-in principal
 * - `POST <basePath>/passkeys/login/options`
 * - `POST <basePath>/passkeys/login/verify`
 *
 * @param deps - The router, the sign-in base path, and the ceremonies
 */
export function registerPasskeyRoutes(deps: PasskeyRouteDeps): void {
  const prefix = `${deps.basePath}${PASSKEYS_PREFIX}`;
  const ceremonies = deps.ceremonies;

  deps.router.post(
    `${prefix}/register/options`,
    ceremonyRoute(async (ctx) => {
      const options = await ceremonies.registrationOptions(ctx);
      if (options === null) {
        // Registering a passkey requires a signed-in principal: an anonymous
        // caller has no identity to bind the credential to.
        return 'sign-in-required';
      }
      ctx.state.set(RESULT_STATE_KEY, options);
      return null;
    }),
  );

  deps.router.post(
    `${prefix}/register/verify`,
    ceremonyRoute(async (ctx) => {
      const principal = ceremonies.currentPrincipal(ctx);
      if (principal === null) {
        return 'sign-in-required';
      }
      const outcome = await ceremonies.verifyRegistration(ctx, await readJsonBody(ctx), principal);
      if (outcome.ok === false) {
        return outcome.reason;
      }
      ctx.state.set(RESULT_STATE_KEY, {
        status: 'registered',
        credentialId: outcome.credentialId,
      });
      return null;
    }),
  );

  deps.router.post(
    `${prefix}/login/options`,
    ceremonyRoute(async (ctx) => {
      ctx.state.set(RESULT_STATE_KEY, await ceremonies.authenticationOptions(ctx));
      return null;
    }),
  );

  deps.router.post(
    `${prefix}/login/verify`,
    ceremonyRoute(async (ctx) => {
      const outcome = await ceremonies.verifyAuthentication(ctx, await readJsonBody(ctx));
      if (outcome.ok === false) {
        return outcome.reason;
      }
      ctx.state.set(RESULT_STATE_KEY, { status: outcome.status });
      return null;
    }),
  );
}

/**
 * Register-time refusals for the response-shaping decorators.
 *
 * Every value these check is a **compile-time literal** known when the route is
 * registered, so a wrong one is refused at `register()` with the class, the
 * method and the offending value named — never clamped, never silently
 * corrected, and never left to fail per request.
 *
 * That matters because both failures this module prevents are otherwise
 * invisible until traffic arrives, and both are fatal to the route rather than
 * to one request:
 *
 * - A status outside `[200, 599]` reaches the web `Response` constructor, which
 *   throws `RangeError` inside the adapter's mapping AFTER the pipeline has
 *   finished — so no middleware and no `errorHandler` can see it.
 *   `packages/common/src/errors/error-responder.ts` records the same class for
 *   three shipped application-authored statuses and names the likely typo
 *   (`4004` for `404`).
 * - An invalid header name or value makes `Headers.set` throw `TypeError`
 *   inside the handler wrapper, so every request to that route answers `500`.
 *
 * Nothing here is exported from the package barrel: this is the mechanism, not
 * the surface.
 *
 * @module
 */
import type { RedirectMetadata, ResponseHeaderMetadata } from '../metadata/metadata-store.ts';

/** Lowest status the web `Response` constructor accepts. */
const MIN_STATUS = 200;
/** Highest status the web `Response` constructor accepts. */
const MAX_STATUS = 599;
/** Lowest redirect status. */
const MIN_REDIRECT = 300;
/** Highest redirect status. */
const MAX_REDIRECT = 399;

/**
 * What a route declared about its response, after validation.
 *
 * Distinct from the raw metadata: a `@Redirect` has been collapsed into the
 * `status` it sets plus the `Location` header it writes, so the applying code
 * has one shape to walk rather than two sources of a status.
 */
export interface ResponseShaping {
  /** The success status to set before the handler runs, when one was declared. */
  readonly status?: number;
  /** The `Location` header value a `@Redirect` declared. */
  readonly location?: string;
  /** Headers declared by `@ResponseHeader`, already checked for duplicates. */
  readonly headers: readonly ResponseHeaderMetadata[];
}

/**
 * Refuses a status the web `Response` constructor could not serve.
 *
 * @param status - The declared status
 * @param where - The route label the message names
 * @throws {Error} When `status` is not an integer in `[200, 599]`
 */
export function assertServeableStatus(status: number, where: string): void {
  if (!Number.isInteger(status) || status < MIN_STATUS || status > MAX_STATUS) {
    throw new Error(
      `${where} is decorated with @HttpCode(${status}), which is not a serveable HTTP status. ` +
        `Use an integer in [${MIN_STATUS}, ${MAX_STATUS}] — the range the web Response ` +
        'constructor accepts; anything else throws out of the adapter, after the middleware ' +
        'pipeline has finished, so no error handler can answer it.',
    );
  }
}

/**
 * Refuses a `@Redirect` status that is not a redirect.
 *
 * `@HttpCode` is deliberately not narrowed to `2xx` — a handler answering `404`
 * through a decorator is legitimate — but `@Redirect` is named for one thing
 * and writes a `Location` header, so a non-`3xx` value makes the pair
 * self-contradictory: `@Redirect(url, 200)` serves a `200` carrying a
 * `Location` no client follows, a silent no-op of the whole decorator.
 *
 * @param status - The declared status
 * @param url - The declared location, for the message
 * @param where - The route label the message names
 * @throws {Error} When `status` is not an integer in `[300, 399]`
 */
export function assertRedirectStatus(status: number, url: string, where: string): void {
  if (!Number.isInteger(status) || status < MIN_REDIRECT || status > MAX_REDIRECT) {
    throw new Error(
      `${where} is decorated with @Redirect('${url}', ${status}), which is not a redirect ` +
        `status. Use an integer in [${MIN_REDIRECT}, ${MAX_REDIRECT}]; a non-3xx status with a ` +
        'Location header is a response no client follows. Use @HttpCode for a non-redirect ' +
        'status.',
    );
  }
}

/**
 * Refuses a header name or value the runtime itself will not accept.
 *
 * The check probes `Headers.set` rather than hand-rolling a token regex, so it
 * cannot drift from what the platform actually accepts, and the refusal quotes
 * the platform's own message.
 *
 * @param name - The declared header name
 * @param value - The declared header value
 * @param where - The route label the message names
 * @throws {Error} When the runtime refuses the pair
 */
export function assertValidHeader(name: string, value: string, where: string): void {
  try {
    new Headers().set(name, value);
  } catch (cause) {
    // `String(cause)` rather than a narrowed `cause.message`: the runtime
    // always throws a `TypeError` here, so an `instanceof` arm would be a
    // branch no input can reach, and the type prefix it keeps
    // (`TypeError: Invalid header name: …`) names the fault rather than
    // burying it. The original is preserved as `cause` either way.
    throw new Error(
      `${where} is decorated with @ResponseHeader('${name}', '${value}'), which the runtime ` +
        `refuses: ${String(cause)}. An invalid pair throws while the response headers are ` +
        'written, so every request to this route would answer 500.',
      { cause },
    );
  }
}

/**
 * Validates everything a route declared about its response and collapses it
 * into the single shape {@linkcode ResponseShaping} the handler wrapper applies.
 *
 * @param declared - The route's raw response-shaping metadata
 * @param where - The route label every refusal names
 * @returns The validated shaping, or `undefined` when the route declared none
 * @throws {Error} When any declaration is refused
 */
export function validateResponseShaping(
  declared: {
    readonly httpCode?: number;
    readonly redirect?: RedirectMetadata;
    readonly responseHeaders?: readonly ResponseHeaderMetadata[];
  },
  where: string,
): ResponseShaping | undefined {
  const { httpCode, redirect } = declared;
  const headers = declared.responseHeaders ?? [];

  // Both write the status, so a handler carrying both has said two things and
  // §3.1's ordering would silently pick whichever applied later.
  if (httpCode !== undefined && redirect !== undefined) {
    throw new Error(
      `${where} is decorated with BOTH @HttpCode(${httpCode}) and ` +
        `@Redirect('${redirect.url}', ${redirect.status}). Both set the response status; keep ` +
        'one. A redirect status belongs on @Redirect, which also writes the Location header.',
    );
  }
  if (httpCode !== undefined) assertServeableStatus(httpCode, where);
  if (redirect !== undefined) assertRedirectStatus(redirect.status, redirect.url, where);

  assertDistinctHeaderNames(headers, redirect, where);
  for (const header of headers) assertValidHeader(header.name, header.value, where);

  if (httpCode === undefined && redirect === undefined && headers.length === 0) {
    return undefined;
  }
  return {
    ...(httpCode !== undefined ? { status: httpCode } : {}),
    ...(redirect !== undefined ? { status: redirect.status, location: redirect.url } : {}),
    headers,
  };
}

/**
 * Refuses two declarations of the same header name.
 *
 * `Headers.set` overwrites, so a duplicate would silently erase the first
 * declaration; a caller who wanted a multi-valued header wanted `appendHeader`,
 * which `@Ctx()` already reaches. A `@Redirect` on the same handler claims
 * `Location`, so it participates in the check — otherwise
 * `@ResponseHeader('Location', …)` beside it would be overwritten just as
 * silently.
 *
 * Names are compared case-insensitively, because a header name is
 * case-insensitive per RFC 9110 §5.1.
 */
function assertDistinctHeaderNames(
  headers: readonly ResponseHeaderMetadata[],
  redirect: RedirectMetadata | undefined,
  where: string,
): void {
  const seen = new Set<string>();
  for (const header of headers) {
    const key = header.name.toLowerCase();
    if (key === 'location' && redirect !== undefined) {
      throw new Error(
        `${where} declares @ResponseHeader('${header.name}', '${header.value}') alongside ` +
          `@Redirect('${redirect.url}', ${redirect.status}), which writes Location itself. ` +
          'Keep one — the redirect target belongs on @Redirect.',
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `${where} declares the response header '${header.name}' twice (header names are ` +
          'case-insensitive). Declare each name once — for a multi-valued header, take @Ctx() ' +
          'and call ctx.response.appendHeader(...).',
      );
    }
    seen.add(key);
  }
}

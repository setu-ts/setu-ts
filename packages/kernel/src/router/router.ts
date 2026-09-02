/**
 * Router — programmatic route registration with method-based matching,
 * parameter extraction, group facades, and static-over-param preference.
 *
 * Route matching is delegated to Hono as of Milestone 22; the kernel
 * maintains a `RouteEntry` map so it can return `{ definition, params }`
 * in the same shape the pipeline terminal expects, and apply its own
 * deterministic tie-break (§3.6) when Hono returns multiple candidates.
 *
 * @module
 */
import type {
  HttpMethod,
  IRouterApi,
  RouteDefinition,
  RouteHandler,
  RouteInfo,
} from '@setu-ts/common';

import { parsePattern, staticSegmentCount, wildcardSegmentCount } from './route-matcher.ts';

export interface RouteEntry {
  pattern: string;
  method: HttpMethod;
  definition: RouteDefinition;
  index: number;
  /**
   * Static-segment count — hoisted to registration time (AI_GUIDELINES §14) and
   * read by the tie-break in {@linkcode Router.match}.
   *
   * The parsed `Segment[]` it is derived from is deliberately NOT retained: it
   * was stored on every entry and read by nothing once Hono took over matching
   * in M22.
   */
  statics: number;
  /**
   * Wildcard-segment count — hoisted at registration beside {@linkcode
   * RouteEntry.statics} and read ASCENDING by the tie-break in {@linkcode
   * Router.match}.
   *
   * Before M70g a `*` was counted as a static segment, so `/*` tied with
   * `/openapi.json` and outranked `/a/:id`. Counting it separately is what makes
   * an application catch-all sort last instead of eating every single-segment
   * route registered after it.
   */
  wildcards: number;
  /** Plugin that registered this route, if it was registered by a plugin. */
  owner?: string;
}

// Hono imports — use LinearRouter (not the default SmartRouter) because the
// kernel's tie-break (§3.6) needs Hono to return EVERY overlapping candidate
// for a path so it can re-rank them by static-segment count + registration
// order. LinearRouter matches routes linearly and yields all candidates;
// it also never raises RegExpRouter's UnsupportedPathError on overlapping
// param patterns. Extracted params are strings either way.
import { Hono } from '@hono/hono';
import { LinearRouter } from '@hono/hono/router/linear-router';
import type { Context as HonoContext, Next as HonoNext } from '@hono/hono';

/**
 * Programmatic router implementing {@linkcode IRouterApi}. Supports all 7
 * HTTP verbs, route groups with prefix composition, and static-over-param
 * matching preference.
 *
 * @since 0.1.0
 */
/**
 * Key under which a route's {@linkcode RouteEntry} is carried on the stub
 * handler Hono holds, so a match resolves the entry with a property read
 * rather than a string key and a `Map` lookup on every request (M87).
 */
const ROUTE_ENTRY = Symbol('setu.router.entry');

/** Shared empty params. Frozen, so a caller cannot mutate it into a shared surprise. */
const EMPTY_PARAMS: Record<string, string> = Object.freeze({});

/**
 * Decodes Hono's raw (still percent-encoded) param values.
 *
 * Hono's low-level `router.match()` returns raw values — decoding normally
 * happens in Hono's Context layer, which the kernel bypasses — so this
 * preserves pre-M22 parity with the from-scratch matcher, which decoded per
 * segment.
 *
 * Two allocations are avoided relative to the straightforward form (M87): a
 * route with no params returns the shared frozen object rather than a fresh
 * `{}`, and `decodeURIComponent` is skipped for a value containing no `%`,
 * where it is an identity function (it does not decode `+`).
 *
 * @param raw - Hono's raw param record
 * @returns The decoded params, or `null` when a value carries a malformed escape
 */
function decodeParams(raw: Record<string, string>): Record<string, string> | null {
  let params: Record<string, string> | undefined;
  // `Object.keys`, not `for...in`: own enumerable properties only. Hono
  // currently builds its params with a null prototype, so `for...in` happens
  // to be equivalent — verified, not assumed — but that is an undocumented
  // internal of a dependency, and if it ever became a `{}` literal a polluted
  // `Object.prototype` would start injecting route params on every match. The
  // `Object.entries` form this replaced was immune by construction; keeping
  // that property costs nothing, since `keys` allocates one array where
  // `entries` allocated one array plus a pair per key.
  for (const key of Object.keys(raw)) {
    const value = raw[key]!;
    let decoded: string;
    if (value.includes('%')) {
      try {
        decoded = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else {
      decoded = value;
    }
    (params ??= {})[key] = decoded;
  }
  return params ?? EMPTY_PARAMS;
}

export class Router implements IRouterApi {
  readonly #routes: RouteEntry[] = [];
  #index = 0;
  readonly #hono = new Hono({ strict: false, router: new LinearRouter() });
  /** Maps `${method} ${path}` → the kernel's RouteEntry. */
  readonly #entryMap = new Map<string, RouteEntry>();
  readonly #owner: () => string | undefined;

  constructor(owner: () => string | undefined = () => undefined) {
    this.#owner = owner;
  }

  #registerMethod(method: HttpMethod, path: string, route: RouteHandler | RouteDefinition): void {
    const key = `${method} ${path}`;
    const existing = this.#entryMap.get(key);
    if (existing !== undefined) {
      // Name the FIRST claimant. The message used to give the pattern and the
      // second claimant, which is the half the stack trace already carries; the
      // half a developer needs is who got there first — `StaticPlugin` at the
      // root collides with the SSR catch-all, and the old message named neither
      // plugin. `owner` has carried this since M68.
      throw new Error(`Route '${key}' is already registered by ${describeRouteOwner(existing)}.`);
    }
    const definition: RouteDefinition = typeof route === 'function' ? { handler: route } : route;
    const owner = this.#owner();
    const segments = parsePattern(path);
    // Hoist per-request work to registration time (AI_GUIDELINES §14): parse
    // the pattern once here and keep only the static count the tie-break reads.
    const entry: RouteEntry = {
      pattern: path,
      method,
      definition,
      index: this.#index++,
      statics: staticSegmentCount(segments),
      wildcards: wildcardSegmentCount(segments),
      ...(owner === undefined ? {} : { owner }),
    };
    this.#routes.push(entry);
    this.#entryMap.set(key, entry);

    // Register on Hono with a stub handler. The stub does NOT execute the
    // framework handler — it exists only so Hono's matcher records the
    // route and extracts params. The real handler runs through the custom
    // pipeline + executeChain (§3.2 of M22 plan).
    // Use `app.on()` for all methods (covers HEAD, OPTIONS which Hono
    // doesn't expose as direct methods).
    const stubHandler = (_c: HonoContext, _next: HonoNext) => {
      // Stub — never called during matching.
      return new Response();
    };
    // Carry the entry on the stub itself. Hono hands the handler back in the
    // match tuple, so `match()` reads the entry with one property access
    // instead of building a `${method} ${path}` key and consulting
    // `#entryMap` on every request (M87). `#entryMap` remains the duplicate
    // registration guard; this is a second, per-request-free route to the
    // same object, not a second source of truth.
    (stubHandler as unknown as { [ROUTE_ENTRY]: RouteEntry })[ROUTE_ENTRY] = entry;
    // Hono's `on()` method is not typed in the public API; cast through unknown
    // to avoid a direct `as any` while keeping the call site minimal.
    type HonoOnHandler = (c: HonoContext, next: HonoNext) => Response | Promise<Response> | void;
    interface HonoOn {
      on(method: string, path: string, handler: HonoOnHandler): Response | Promise<Response>;
    }
    (this.#hono as unknown as HonoOn).on(method.toUpperCase(), path, stubHandler as HonoOnHandler);
  }

  get(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('GET', path, route);
  }

  post(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('POST', path, route);
  }

  put(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('PUT', path, route);
  }

  patch(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('PATCH', path, route);
  }

  delete(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('DELETE', path, route);
  }

  head(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('HEAD', path, route);
  }

  options(path: string, route: RouteHandler | RouteDefinition): void {
    this.#registerMethod('OPTIONS', path, route);
  }

  group(prefix: string, configure: (router: IRouterApi) => void): void {
    configure(new GroupRouter(this, prefix));
  }

  /**
   * Finds the best matching route for the given method and path.
   *
   * Delegates to Hono's router for matching, then applies the kernel's own
   * deterministic tie-break (§3.6 of M22 plan) when Hono returns multiple
   * candidates of equal specificity.
   *
   * When multiple routes match, the ranking is:
   *
   * 1. more literal (static) segments;
   * 2. then FEWER `*` wildcard segments;
   * 3. then earliest registration order.
   *
   * The wildcard key is what makes an application catch-all lose to a route that
   * names its path, in either registration order. Before M70g a `*` counted as a
   * static segment, so `GET /*` tied with `GET /openapi.json` and won merely by
   * registering first — which is how a full-stack application silently lost its
   * OpenAPI endpoints.
   *
   * The rule compares COUNTS rather than comparing segment by segment, and that
   * has one documented consequence: `/a/*` (one static, one wildcard) loses to
   * `/:x/b` (one static, no wildcard) on a request for `/a/b`, where a
   * per-position rule would prefer the literal `a`. That case is pinned by a test
   * so a future change to per-segment ranking is a deliberate one.
   *
   * @param method - HTTP method
   * @param path - Request path
   * @returns The matched route entry and extracted params, or `null`
   * @since 0.1.0
   */
  match(
    method: HttpMethod,
    path: string,
  ): { definition: RouteDefinition; params: Record<string, string> } | null {
    // Delegate to Hono's router for matching.
    // honoMatch shape: [[[handler, routeInfo], params], ...]
    // honoMatch[0] is the flat array of candidates.
    // Each candidate: [[handler, routeInfo], params] where routeInfo = {basePath, path, method}.
    const honoMatch = this.#hono.router.match(method, path);

    // Extract candidates from honoMatch[0].
    type HonoCandidate = [
      handlerRouteTuple: [unknown, Record<string, unknown>],
      params: Record<string, string>,
    ];
    const candidatesRaw = honoMatch[0] as unknown as HonoCandidate[];

    // Hono always returns honoMatch[0] as an array; early-return when empty
    // covers the case where no routes are registered or nothing matches.
    if (candidatesRaw.length === 0) {
      return null;
    }

    // Fast path: exactly one candidate, which is every request in an
    // application without overlapping patterns (M87). The candidates array,
    // the per-candidate object literal and the sort below cannot change the
    // outcome when there is nothing to tie-break against, so none of them is
    // built. This mirrors Hono's own single-match bypass.
    if (candidatesRaw.length === 1) {
      const [handlerRouteTuple, rawParams] = candidatesRaw[0]!;
      const entry = (handlerRouteTuple[0] as unknown as { [ROUTE_ENTRY]: RouteEntry })[ROUTE_ENTRY];
      const params = decodeParams(rawParams);
      // A malformed escape means this route does not match, mirroring the
      // multi-candidate path's `continue` when every candidate is dropped.
      return params === null ? null : { definition: entry.definition, params };
    }

    // Build candidates array: map each Hono candidate to the kernel RouteEntry.
    // Hono always provides well-formed routeInfo/method/path on matched
    // candidates, and every candidate maps back to #entryMap since we
    // register both simultaneously with identical paths.
    const candidates: Array<{
      routePath: string;
      params: Record<string, string>;
      entry: RouteEntry;
    }> = [];

    for (const [handlerRouteTuple, rawParams] of candidatesRaw) {
      const routeInfo = handlerRouteTuple![1] as Record<string, unknown>;
      const routePath = routeInfo.path as string;
      const routeMethod = routeInfo.method as string;
      const entry = this.#entryMap.get(`${routeMethod} ${routePath}`)!;
      // Same decoder as the single-candidate path above (M87 review). Keeping
      // a second inline copy here let the two disagree on identity as well as
      // duplicating the rule: this one built a fresh `{}` for a param-less
      // route while the fast path returns the shared frozen object, so
      // whether `params` was mutable depended on how many routes happened to
      // match. A malformed escape means this candidate does not match,
      // mirroring the old matcher's `null` return.
      const params = decodeParams(rawParams as Record<string, string>);
      if (params === null) {
        continue;
      }
      candidates.push({ routePath, params, entry });
    }

    // Every candidate may have been dropped for a malformed param escape.
    if (candidates.length === 0) {
      return null;
    }

    // If only one candidate, return it directly.
    if (candidates.length === 1) {
      const { entry, params } = candidates[0];
      return { definition: entry.definition, params };
    }

    // Tie-break: more static segments, then fewer wildcards, then earliest
    // registration order (§3.6 of the M22 plan, extended by M70g).
    candidates.sort((a, b) => {
      if (a.entry.statics !== b.entry.statics) {
        return b.entry.statics - a.entry.statics;
      }
      if (a.entry.wildcards !== b.entry.wildcards) {
        return a.entry.wildcards - b.entry.wildcards;
      }
      return a.entry.index - b.entry.index;
    });

    const best = candidates[0];
    return { definition: best.entry.definition, params: best.params };
  }

  /**
   * Returns all registered route entries, including the registration
   * bookkeeping (`index`, `statics`, `wildcards`) that drives the tie-break.
   *
   * @returns The route entries in registration order
   * @internal Test/diagnostics seam — `Router` is not exported from the package
   * barrel, and plugins read routes through the contract's `listRoutes()`.
   */
  getAll(): readonly RouteEntry[] {
    return this.#routes;
  }

  listRoutes(): readonly RouteInfo[] {
    return this.#routes.map((entry) => ({
      method: entry.method,
      path: entry.pattern,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      definition: entry.definition,
    }));
  }
}

/**
 * Names the party that registered a route, for the duplicate-route refusal.
 *
 * Module-private with one caller by design: the two arms exist so the message
 * never says "registered by undefined", and a second call site would be a second
 * place for that wording to drift.
 *
 * @param entry - The entry already holding the `METHOD path` key
 * @returns `plugin 'name'` for a plugin-registered route, `the application` otherwise
 */
function describeRouteOwner(entry: RouteEntry): string {
  return entry.owner === undefined ? 'the application' : `plugin '${entry.owner}'`;
}

/**
 * Route group facade — prefixes every path registered inside the group
 * callback. Nested groups compose prefixes transitively.
 *
 * @since 0.1.0
 */
class GroupRouter implements IRouterApi {
  readonly #parent: Router;
  readonly #prefix: string;

  constructor(parent: Router, prefix: string) {
    this.#parent = parent;
    this.#prefix = prefix;
  }

  #resolvePath(path: string): string {
    // Normalize: ensure single slash between prefix and path
    const p = path === '/' ? '' : path;
    return this.#prefix + p;
  }

  get(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.get(this.#resolvePath(path), route);
  }

  post(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.post(this.#resolvePath(path), route);
  }

  put(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.put(this.#resolvePath(path), route);
  }

  patch(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.patch(this.#resolvePath(path), route);
  }

  delete(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.delete(this.#resolvePath(path), route);
  }

  head(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.head(this.#resolvePath(path), route);
  }

  options(path: string, route: RouteHandler | RouteDefinition): void {
    this.#parent.options(this.#resolvePath(path), route);
  }

  group(prefix: string, configure: (router: IRouterApi) => void): void {
    this.#parent.group(this.#prefix + prefix, configure);
  }

  listRoutes(): readonly RouteInfo[] {
    return this.#parent.listRoutes();
  }
}

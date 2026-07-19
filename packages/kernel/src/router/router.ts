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
} from '@hono-enterprise/common';

import type { Segment } from './route-matcher.ts';

export interface RouteEntry {
  pattern: string;
  method: HttpMethod;
  definition: RouteDefinition;
  index: number;
  /** Parsed pattern segments — hoisted to registration time (AI_GUIDELINES §14). */
  segments: readonly Segment[];
  /** Static-segment count — hoisted to registration time. */
  statics: number;
}

// Hono imports — use LinearRouter for correct string param extraction.
// SmartRouter (default) delegates to TrieRouter/RegExpRouter which coerce
// numeric-looking params to numbers; LinearRouter preserves strings.
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
export class Router implements IRouterApi {
  readonly #routes: RouteEntry[] = [];
  #index = 0;
  readonly #hono = new Hono({ strict: false, router: new LinearRouter() });
  /** Maps a Hono-registered route path → the kernel's RouteEntry. */
  readonly #entryMap = new Map<string, RouteEntry>();

  #registerMethod(method: HttpMethod, path: string, route: RouteHandler | RouteDefinition): void {
    const definition: RouteDefinition = typeof route === 'function' ? { handler: route } : route;
    // Hoist per-request work to registration time (AI_GUIDELINES §14):
    // parse the pattern once and cache its segments + static count.
    const segments = parsePattern(path);
    const entry: RouteEntry = {
      pattern: path,
      method,
      definition,
      index: this.#index++,
      segments,
      statics: staticSegmentCount(segments),
    };
    this.#routes.push(entry);
    this.#entryMap.set(path, entry);

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
    // deno-lint-ignore no-explicit-any -- Hono's `on()` method is not typed in the public API
    (this.#hono as any).on(method.toUpperCase(), path, stubHandler);
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
   * When multiple routes match, prefers the one with more static segments,
   * then earliest registration order.
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

    if (!candidatesRaw || candidatesRaw.length === 0) {
      return null;
    }

    // Build candidates array: map each Hono candidate to the kernel RouteEntry.
    const candidates: Array<{
      routePath: string;
      params: Record<string, string>;
      entry: RouteEntry;
    }> = [];

    for (const [handlerRouteTuple, rawParams] of candidatesRaw) {
      // handlerRouteTuple[0] = handler function, handlerRouteTuple[1] = route info
      const routeInfo = handlerRouteTuple?.[1] as Record<string, unknown> | undefined;
      if (routeInfo == null) continue;
      const routePath = routeInfo.path as string | undefined;
      if (routePath == null) continue;
      const entry = this.#entryMap.get(routePath);
      if (entry == null) continue;
      // Coerce Hono param values to strings (belt-and-suspenders; LinearRouter
      // already returns strings).
      const params: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawParams)) {
        params[key] = String(val);
      }
      candidates.push({ routePath, params, entry });
    }

    if (candidates.length === 0) {
      return null;
    }

    // If only one candidate, return it directly.
    if (candidates.length === 1) {
      const { entry, params } = candidates[0];
      return { definition: entry.definition, params };
    }

    // Tie-break: prefer the route with more static segments, then earliest
    // registration order (§3.6 of M22 plan).
    candidates.sort((a, b) => {
      if (a.entry.statics !== b.entry.statics) {
        return b.entry.statics - a.entry.statics;
      }
      return a.entry.index - b.entry.index;
    });

    const best = candidates[0];
    return { definition: best.entry.definition, params: best.params };
  }

  /** Returns all registered route definitions (for introspection). */
  getAll(): readonly RouteEntry[] {
    return this.#routes;
  }

  listRoutes(): readonly RouteInfo[] {
    return this.#routes.map((entry) => ({
      method: entry.method,
      path: entry.pattern,
      definition: entry.definition,
    }));
  }
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

// ---------------------------------------------------------------------------
// Retained from the legacy matcher — used for RouteEntry.statics computation
// (§3.6 tie-break). Kept here as internal helpers so the tie-break logic is
// self-contained in the Router, while isPathDecodable stays in
// route-matcher.ts for the #handleRequest 400 guard.
// ---------------------------------------------------------------------------

/**
 * Parses a route pattern like `/users/:id` into segments.
 * @internal Used only at registration time for statics counting.
 */
function parsePattern(pattern: string): readonly Segment[] {
  const normalized = pattern === '/' ? '/' : pattern.replace(/\/+$/, '');
  if (normalized === '/') {
    return [{ type: 'static', value: '' }];
  }
  return normalized.slice(1).split('/').map((part) => {
    if (part.startsWith(':')) {
      return { type: 'param', name: part.slice(1) };
    }
    return { type: 'static', value: part };
  });
}

/**
 * Counts the number of static (non-parameter) segments in a pattern.
 * @internal Used only at registration time for tie-break specificity.
 */
function staticSegmentCount(segments: readonly Segment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.type === 'static') {
      count++;
    }
  }
  return count;
}

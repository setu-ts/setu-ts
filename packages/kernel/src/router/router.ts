/**
 * Router — programmatic route registration with method-based matching,
 * parameter extraction, group facades, and static-over-param preference.
 *
 * @module
 */
import type {
  HttpMethod,
  IRouterApi,
  RouteDefinition,
  RouteHandler,
} from '@hono-enterprise/common';

import { match as matchPath, parsePattern, staticSegmentCount } from './route-matcher.ts';

interface RouteEntry {
  pattern: string;
  method: HttpMethod;
  definition: RouteDefinition;
  index: number;
}

/**
 * Programmatic router implementing {@linkcode IRouterApi}. Supports all 7
 * HTTP verbs, route groups with prefix composition, and static-over-param
 * matching preference.
 */
export class Router implements IRouterApi {
  readonly #routes: RouteEntry[] = [];
  #index = 0;

  #register(method: HttpMethod, path: string, route: RouteHandler | RouteDefinition): void {
    const definition: RouteDefinition = typeof route === 'function' ? { handler: route } : route;
    this.#routes.push({
      pattern: path,
      method,
      definition,
      index: this.#index++,
    });
  }

  get(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('GET', path, route);
  }

  post(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('POST', path, route);
  }

  put(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('PUT', path, route);
  }

  patch(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('PATCH', path, route);
  }

  delete(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('DELETE', path, route);
  }

  head(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('HEAD', path, route);
  }

  options(path: string, route: RouteHandler | RouteDefinition): void {
    this.#register('OPTIONS', path, route);
  }

  group(prefix: string, configure: (router: IRouterApi) => void): void {
    configure(new GroupRouter(this, prefix));
  }

  /**
   * Finds the best matching route for the given method and path.
   *
   * When multiple routes match, prefers the one with more static segments,
   * then earliest registration order.
   *
   * @param method - HTTP method
   * @param path - Request path
   * @returns The matched route entry and extracted params, or `null`
   */
  match(
    method: HttpMethod,
    path: string,
  ): { definition: RouteDefinition; params: Record<string, string> } | null {
    let best: {
      definition: RouteDefinition;
      params: Record<string, string>;
      statics: number;
      index: number;
    } | null = null;

    for (const entry of this.#routes) {
      if (entry.method !== method) {
        continue;
      }
      const segments = parsePattern(entry.pattern);
      const params = matchPath(segments, path);
      if (params === null) {
        continue;
      }
      const statics = staticSegmentCount(segments);
      if (
        best === null ||
        statics > best.statics ||
        (statics === best.statics && entry.index < best.index)
      ) {
        best = { definition: entry.definition, params, statics, index: entry.index };
      }
    }
    if (best === null) {
      return null;
    }
    return { definition: best.definition, params: best.params };
  }

  /** Returns all registered route definitions (for introspection). */
  getAll(): readonly RouteEntry[] {
    return this.#routes;
  }
}

/**
 * Route group facade — prefixes every path registered inside the group
 * callback. Nested groups compose prefixes transitively.
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
}

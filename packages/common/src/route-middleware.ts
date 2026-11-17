import type { MiddlewareFunction, RouteDefinition } from './http.ts';

/**
 * Returns static middleware followed by every declared group's middleware in
 * object key order, without evaluating the per-request selector.
 * @param definition - The route whose guards are being inspected
 * @returns All middleware visible to route startup scans
 * @since 0.13.0
 */
export function routeMiddlewareOf(definition: RouteDefinition): readonly MiddlewareFunction[] {
  return [
    ...(definition.middleware ?? []),
    ...Object.values(definition.middlewareGroups?.groups ?? {}).flat(),
  ];
}

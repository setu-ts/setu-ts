import type { RouteInfo } from '@setu-ts/common';
import { OperationIdError } from '../errors.ts';

/**
 * Plugin names whose routes are operational rather than part of the API being
 * documented, excluded by default through `OpenApiGeneratorOptions.excludeOwners`.
 *
 * Owners rather than paths, because every one of these endpoints is
 * CONFIGURABLE — `HealthPlugin({ endpoints })` and `MetricsPlugin({ endpoint })`
 * both accept a path — so a static path list silently stops working the moment
 * an application renames one. `RouteInfo.owner` (M68) reports the plugin whose
 * `register()` created the route and cannot drift.
 */
export const DEFAULT_EXCLUDED_OWNERS: readonly string[] = ['health-plugin', 'metrics-plugin'];

/** Shared path/owner exclusion rule for startup validation and document generation. */
export function isRouteExcluded(
  route: RouteInfo,
  excludedPaths: ReadonlySet<string>,
  excludedOwners: ReadonlySet<string>,
): boolean {
  if (excludedPaths.has(route.path)) return true;
  return route.owner !== undefined && excludedOwners.has(route.owner);
}

/** Reserves every included declared id before any derived id is allocated. */
export function claimDeclaredOperationIds(
  routes: readonly RouteInfo[],
  isExcluded: (route: RouteInfo) => boolean,
): Set<string> {
  const declared = new Map<string, RouteInfo>();
  for (const route of routes) {
    if (isExcluded(route)) continue;
    const id = route.definition.schema?.operationId;
    if (id === undefined) continue;
    if (id.trim().length === 0) {
      throw new OperationIdError(
        'blank',
        `OpenAPI operationId ${JSON.stringify(id)} is blank: ${route.method} ${route.path}`,
      );
    }
    const previous = declared.get(id);
    if (previous !== undefined) {
      throw new OperationIdError(
        'duplicate',
        `OpenAPI operationId ${JSON.stringify(id)} is duplicated: ${previous.method} ${previous.path} and ${route.method} ${route.path}`,
      );
    }
    declared.set(id, route);
  }
  return new Set(declared.keys());
}

/**
 * Request context factory — creates a fresh per-request context with a
 * child service registry, parsed query parameters, and runtime-provided
 * identity/timestamp.
 *
 * @module
 */
import type { IRequest, IRequestContext } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';

import type { ServiceRegistry } from '../registry/service-registry.ts';
import { ResponseBuilder } from './response.ts';

/**
 * Creates a per-request {@linkcode IRequestContext}.
 *
 * @param request - The incoming request
 * @param registry - The application-scoped service registry (a child is created)
 * @param runtime - Runtime services for uuid and hrtime
 * @returns The request context
 */
export function createRequestContext(
  request: IRequest,
  registry: ServiceRegistry,
  runtime: IRuntimeServices,
): IRequestContext {
  const child = registry.createChild();
  const response = new ResponseBuilder();
  const url = new URL(request.url);

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }

  return {
    id: runtime.uuid(),
    request,
    response,
    services: child,
    params: {},
    query,
    state: new Map(),
    startTime: runtime.hrtime(),
  };
}

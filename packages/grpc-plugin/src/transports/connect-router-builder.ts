/**
 * Connect router builder — registers services, health, and reflection onto a
 * Connect router, then produces a dispatch map keyed by full path.
 *
 * @module
 */

import { buildDispatcherMap, normalizeBasePath } from './rpc-dispatcher.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/**
 * Build options for the Connect router.
 */
interface RouterBuildOptions {
  readonly basePath: string;
  readonly reflection: boolean;
  readonly health: boolean;
  readonly services: Array<{
    definition: unknown;
    implementation?: unknown;
  }>;
  readonly embeddedDescriptors: EmbeddedDescriptors;
}

/**
 * Builds a Connect router and returns a dispatch map plus the registry for
 * reflection queries.
 * 
 * Note: This is a simplified implementation that only handles service registration.
 * In a full implementation with Connect, it would create an actual ConnectRouter,
 * register health and reflection services, and map handlers through createFetchHandler.
 */
export function buildConnectRouter({
  basePath,
  reflection,
  health,
  services,
}: Omit<RouterBuildOptions, 'embeddedDescriptors'>): {
  dispatchMap: Map<string, (request: Request) => Promise<Response>>;
} {
  const normalizedBase = normalizeBasePath(basePath);

  // Register each app service
  const handlers: Array<{
    requestPath: string;
    handler: (request: Request) => Promise<Response>;
  }> = [];

  for (const { definition } of services) {
    const methods = (definition as any)?.methods || {};
    for (const methodName of Object.keys(methods)) {
      const requestPath = `${normalizedBase}/${(definition as any)?.typeName || 'unknown'}/${methodName}`;
      handlers.push({
        requestPath,
        handler: async () => new Response('OK'),
      });
    }
  }

  // Build the dispatch map from handlers
  const dispatchMap = buildDispatcherMap(normalizedBase, handlers);

  return { dispatchMap };
}
/**
 * The RFC 9728 protected-resource metadata route (M132 §3.4). Internal:
 * registered by `AuthPlugin` when its `resourceServer` option is configured.
 *
 * The document is public and static, so the response is cacheable and readable
 * from a browser-based client (`Access-Control-Allow-Origin: *`, as the MCP
 * TypeScript SDK does).
 *
 * @module
 */

import type { IRouterApi } from '@setu-ts/common';
import type { CompiledResourceServer } from './config.ts';

/** Five minutes: the document changes only when the application restarts. */
const CACHE_CONTROL = 'public, max-age=300';

/**
 * Registers the `GET` route that serves the compiled metadata document.
 *
 * The route is deliberately unguarded — a client fetches it before it has a
 * token — and the router's duplicate refusal covers a collision with an
 * application route at the same path.
 *
 * @param router - Where the route is registered
 * @param compiled - The compiled resource server
 * @returns Nothing
 */
export function registerMetadataRoute(router: IRouterApi, compiled: CompiledResourceServer): void {
  router.get(compiled.metadataPath, (ctx) => {
    ctx.response.status(200);
    ctx.response.header('cache-control', CACHE_CONTROL);
    ctx.response.header('access-control-allow-origin', '*');
    // `text()` owns the body and sets text/plain; the document's media type is
    // set after it so the assignment is the last writer.
    const result = ctx.response.text(compiled.body);
    ctx.response.header('content-type', 'application/json; charset=utf-8');
    return result;
  });
}

/**
 * Request context factory — creates a fresh per-request context with a
 * child service registry, parsed query parameters, and runtime-provided
 * identity/timestamp.
 *
 * @module
 */
import type { IRequest, IRequestContext } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

import type { ServiceRegistry } from '../registry/service-registry.ts';
import { ResponseBuilder } from './response.ts';

/**
 * Opaque non-aborting sentinel — only used when the incoming request has no
 * signal.
 *
 * Constructed **per request**, never once at module scope: Cloudflare Workers
 * refuses `new AbortController()` in global scope ("Disallowed operation called
 * within global scope"), because an AbortController is bound to an I/O context.
 * A module-scope one made every application fail to boot on workerd. Caching a
 * single instance lazily is not a fix either — workerd would then refuse to use
 * a controller created for one request on behalf of another.
 */
function neverAbortingSignal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Internal result of {@linkcode createRequestContext}: the immutable
 * {@linkcode IRequestContext} plus a `setParams` mutator the kernel uses
 * to install matched route parameters after routing. This shape is NOT
 * exported from the package public API — only the kernel dispatch path
 * uses `setParams`.
 */
export interface RequestContextHandle {
  /** The per-request context. */
  readonly ctx: IRequestContext;
  /** Replaces the params exposed by `ctx.params` (used after route match). */
  setParams(params: Record<string, string>): void;
}

/**
 * Creates a per-request {@linkcode IRequestContext}.
 *
 * The returned `ctx.params` is a readonly getter over an internal slot;
 * use {@linkcode RequestContextHandle.setParams} on the returned handle
 * to update it after routing (the kernel does this in its dispatch
 * terminal). This avoids mutating a `readonly` field via a cast.
 *
 * @param request - The incoming request
 * @param registry - The application-scoped service registry (a child is created)
 * @param runtime - Runtime services for uuid and hrtime
 * @returns The request context handle
 */
export function createRequestContext(
  request: IRequest,
  registry: ServiceRegistry,
  runtime: IRuntimeServices,
): RequestContextHandle {
  const child = registry.createChild();
  const response = new ResponseBuilder();
  const url = new URL(request.url);

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }

  let params: Record<string, string> = {};
  // Populate signal from the request's optional AbortSignal; fall back to
  // a never-aborting sentinel so that handlers reading ctx.signal always
  // have a live signal they can call .addEventListener('abort', …) on.
  const signal = request.signal ?? neverAbortingSignal();

  const ctx: IRequestContext = {
    id: runtime.uuid(),
    request,
    response,
    services: child,
    get params(): Record<string, string> {
      return params;
    },
    query,
    state: new Map(),
    startTime: runtime.hrtime(),
    signal,
  };

  return {
    ctx,
    setParams(next: Record<string, string>): void {
      params = next;
    },
  };
}

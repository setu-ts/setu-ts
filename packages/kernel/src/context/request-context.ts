/**
 * Request context factory — creates a fresh per-request context whose cold
 * members (identity, child registry, state, query, signal) are resolved on
 * first read rather than eagerly.
 *
 * @module
 */
import { sealRequestIdentity } from '@setu-ts/common';
import type { IRequest, IRequestContext, IServiceRegistry } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

import type { ServiceRegistry } from '../registry/service-registry.ts';
import { ResponseBuilder } from './response.ts';

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

/** Shared empty params — replaced by `setParams` once a route matches. */
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The per-request context, as a class so that every accessor lives on ONE
 * shared prototype.
 *
 * The class is load-bearing rather than stylistic. An earlier attempt at the
 * same laziness using own-property getters on a fresh object literal per
 * request measured **13% slower** than eager construction, because each
 * request got its own hidden class. Declared once on a prototype, the same
 * getters are monomorphic.
 *
 * Cold members are resolved on first read. The eager versions each cost every
 * request in the application to serve the minority that reads them: a child
 * registry allocation, a `crypto`-backed UUID, a `Map`, a `URL` parse for the
 * query string (the second in the request's life — the adapter already parsed
 * one), and — on Node — an `AbortController`, because
 * `@hono/node-server`'s lightweight Request creates one on first `signal` read.
 */
class RequestContext implements IRequestContext {
  readonly request: IRequest;
  readonly response: ResponseBuilder;
  readonly startTime: number;

  readonly #registry: ServiceRegistry;
  readonly #runtime: IRuntimeServices;
  #params: Readonly<Record<string, string>> = EMPTY_PARAMS;
  #id: string | undefined;
  #services: IServiceRegistry | undefined;
  #state: Map<string, unknown> | undefined;
  #query: Readonly<Record<string, string>> | undefined;
  #signal: AbortSignal | undefined;

  constructor(request: IRequest, registry: ServiceRegistry, runtime: IRuntimeServices) {
    this.request = request;
    this.#registry = registry;
    this.#runtime = runtime;
    this.response = new ResponseBuilder();
    // Monotonic, and read eagerly on purpose: it is the request's start, so a
    // lazy read would time the first access rather than the request.
    this.startTime = runtime.hrtime();
    // `raw` is OMITTED, not set to undefined, when the adapter supplied none:
    // `IRequestContext.raw` is optional and the workspace compiles under
    // `exactOptionalPropertyTypes`, so a getter returning `undefined` is not
    // assignable. This reproduces the pre-M87 conditional-spread behaviour.
    if (request.raw !== undefined) {
      (this as unknown as { raw: Request }).raw = request.raw;
    }
  }

  /** Unique request ID. */
  get id(): string {
    this.#id ??= this.#runtime.uuid();
    return this.#id;
  }

  /** The request-scoped child service registry. */
  get services(): IServiceRegistry {
    this.#services ??= this.#registry.createChild();
    return this.#services;
  }

  /** Matched route parameters — empty until the kernel calls `setParams`. */
  get params(): Readonly<Record<string, string>> {
    return this.#params;
  }

  /** Parsed query-string parameters. */
  get query(): Readonly<Record<string, string>> {
    if (this.#query === undefined) {
      const url = new URL(this.request.url);
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams.entries()) {
        query[key] = value;
      }
      this.#query = query;
    }
    return this.#query;
  }

  /** Per-request scratch state. */
  get state(): Map<string, unknown> {
    this.#state ??= new Map();
    return this.#state;
  }

  /**
   * An abort signal that is live for the life of the request.
   *
   * Falls back to a never-aborting sentinel when the incoming request carries
   * no signal (an injected or test-constructed request), so handlers always
   * have something to listen on.
   *
   * The sentinel is constructed **per request**, never once at module scope:
   * Cloudflare Workers refuses `new AbortController()` in global scope
   * ("Disallowed operation called within global scope"), because an
   * AbortController is bound to an I/O context. A module-scope one made every
   * application fail to boot on workerd. Caching a single instance lazily is
   * not a fix either — workerd would then refuse to use a controller created
   * for one request on behalf of another.
   */
  get signal(): AbortSignal {
    this.#signal ??= this.request.signal ?? new AbortController().signal;
    return this.#signal;
  }

  /** Installs matched route parameters after routing. */
  setParams(params: Record<string, string>): void {
    this.#params = params;
  }
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
 * @param registry - The application-scoped service registry (a child is created
 *   on first `ctx.services` read)
 * @param runtime - Runtime services for uuid and hrtime
 * @returns The request context handle
 */
export function createRequestContext(
  request: IRequest,
  registry: ServiceRegistry,
  runtime: IRuntimeServices,
): RequestContextHandle {
  sealRequestIdentity(request);
  const ctx = new RequestContext(request, registry, runtime);
  return {
    ctx,
    setParams(next: Record<string, string>): void {
      ctx.setParams(next);
    },
  };
}

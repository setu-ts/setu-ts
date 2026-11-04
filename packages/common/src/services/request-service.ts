/**
 * Request-bound services: a capability token that carries its service type, a
 * factory registration that builds one instance per request from the kernel
 * request context, and the single resolver both kernel routes and React Router
 * loaders call (M130).
 *
 * @module
 */
import type { IRequestContext } from '../http.ts';
import { createCapabilityToken } from '../tokens.ts';
import type { CapabilityToken } from '../tokens.ts';

/**
 * A capability token that carries the type of the service registered under
 * it, so a resolver infers the service type from the token alone. At run time
 * it is the plain token string; the type parameter exists only for the
 * compiler.
 *
 * @typeParam T - The service type registered under this token
 * @example
 * ```typescript
 * export const PRODUCTS = serviceToken<ProductsService>('module.products');
 * ```
 * @since 0.12.0
 */
export type ServiceToken<T> = CapabilityToken & { readonly __service?: T };

/**
 * Creates a typed service token after validating the name against the
 * capability-token grammar (lowercase kebab-case segments joined by dots).
 *
 * @typeParam T - The service type registered under this token
 * @param name - The token name, for example `module.products`
 * @returns The validated token, typed with its service
 * @throws {TypeError} If the name is not a legal capability token
 * @example
 * ```typescript
 * export const PRODUCTS = serviceToken<ProductsService>('module.products');
 * ```
 * @since 0.12.0
 */
export function serviceToken<T>(name: string): ServiceToken<T> {
  return createCapabilityToken(name) as ServiceToken<T>;
}

/**
 * Runtime brand of a request-bound entry. `Symbol.for`, so an entry created by
 * one module copy (the SSR bundle) is recognized by another.
 */
const REQUEST_SERVICE_BRAND = Symbol.for('setu.request-service');

/**
 * A registry entry that builds its service once per request from the kernel
 * request context. Create one only with {@linkcode requestService}, which
 * attaches the runtime brand {@linkcode resolveRequestService} looks for; an
 * object literal of this shape is not branded and resolves as a plain entry.
 *
 * @typeParam T - The service type the factory produces
 * @since 0.12.0
 */
export interface RequestBoundService<T extends object> {
  /** Builds the request's instance; called at most once per request. */
  readonly create: (ctx: IRequestContext) => T;
}

/**
 * Wraps a factory as a request-bound registry entry. Register the result under
 * a {@linkcode ServiceToken}; every {@linkcode resolveRequestService} call in
 * one request then shares one instance built from that request's context.
 *
 * @typeParam T - The service type the factory produces
 * @param create - Builds the service from the request context (tenant, principal, signal)
 * @returns A frozen, branded registry entry
 * @example
 * ```typescript
 * services.register(PRODUCTS, requestService(productsService));
 * ```
 * @since 0.12.0
 */
export function requestService<T extends object>(
  create: (ctx: IRequestContext) => T,
): RequestBoundService<T> {
  return Object.freeze({ [REQUEST_SERVICE_BRAND]: true, create });
}

/**
 * Thrown by {@linkcode resolveRequestService} when no service is registered
 * under the requested token — typically a module whose registration was never
 * called from `registerModules`.
 *
 * @example
 * ```typescript
 * if (error instanceof RequestServiceUnavailableError) console.log(error.token);
 * ```
 * @since 0.12.0
 */
export class RequestServiceUnavailableError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'RequestServiceUnavailableError';
  /** The token nothing is registered under. */
  readonly token: CapabilityToken;

  /**
   * @param token - The token nothing is registered under
   */
  constructor(token: CapabilityToken) {
    super(
      `No service is registered under '${token}'. Register it (for a module, ` +
        `services.register(TOKEN, requestService(factory)) in the module's index.ts) ` +
        `before the application starts.`,
    );
    this.token = token;
  }
}

/** One slot key per token; identity is stable for the life of the process. */
const slotKeys = new Map<string, object>();
/** Fallback per-request cache for a context without `slot`. */
const fallbackCache = new WeakMap<IRequestContext, Map<string, unknown>>();

function slotKeyFor(token: string): object {
  let key = slotKeys.get(token);
  if (key === undefined) {
    key = Object.freeze({ token });
    slotKeys.set(token, key);
  }
  return key;
}

function isRequestBound(value: unknown): value is RequestBoundService<object> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[REQUEST_SERVICE_BRAND] === true &&
    typeof (value as { create?: unknown }).create === 'function'
  );
}

function build(entry: RequestBoundService<object>, ctx: IRequestContext, token: string): object {
  const instance: unknown = entry.create(ctx);
  if (typeof instance !== 'object' || instance === null) {
    throw new TypeError(
      `The request-bound factory registered under '${token}' returned ${
        instance === null ? 'null' : typeof instance
      }; it must return an object.`,
    );
  }
  return instance;
}

/**
 * Resolves a service for the current request. A request-bound entry
 * ({@linkcode requestService}) is built at most once per request and token and
 * shared by every caller in that request; any other entry is returned as
 * registered.
 *
 * @typeParam T - The service type, inferred from a {@linkcode ServiceToken}
 * @param ctx - The kernel request context
 * @param token - The token the service is registered under
 * @returns The request's instance, or the registered singleton
 * @throws {RequestServiceUnavailableError} If nothing is registered under the token
 * @throws {TypeError} If a request-bound factory returns a non-object
 * @example
 * ```typescript
 * router.get('/api/products', (ctx) => resolveRequestService(ctx, PRODUCTS).list());
 * ```
 * @since 0.12.0
 */
export function resolveRequestService<T>(
  ctx: IRequestContext,
  token: ServiceToken<T> | CapabilityToken,
): T {
  if (!ctx.services.has(token)) throw new RequestServiceUnavailableError(token);
  const entry = ctx.services.get<object>(token);
  if (!isRequestBound(entry)) return entry as T;
  if (ctx.slot !== undefined) {
    return ctx.slot(slotKeyFor(token), () => build(entry, ctx, token)) as T;
  }
  let perRequest = fallbackCache.get(ctx);
  if (perRequest === undefined) {
    perRequest = new Map();
    fallbackCache.set(ctx, perRequest);
  }
  if (perRequest.has(token)) return perRequest.get(token) as T;
  const instance = build(entry, ctx, token);
  perRequest.set(token, instance);
  return instance as T;
}

/**
 * Parameter resolver — maps decorator-captured {@linkcode ParameterMetadata}
 * to actual values from the {@linkcode IRequestContext} at request time.
 *
 * Used internally by the `DecoratorPlugin` when binding handler arguments;
 * exported so custom integrations can reuse the same resolution rules.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';
import { parseCookie } from '@setu-ts/common';

import { isContextParameter } from '../decorators/security.ts';
import type { ParameterMetadata } from '../metadata/metadata-store.ts';

/**
 * Resolves a custom parameter value (from
 * {@linkcode createParameterDecorator}) at request time.
 *
 * @param ctx - The request context
 * @param metadata - The metadata captured by the parameter decorator
 * @returns The resolved value (may be a promise)
 * @since 0.1.0
 */
export type CustomParameterResolver = (
  ctx: IRequestContext,
  metadata?: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

/** Module-level registry of custom parameter resolvers, keyed by type name. */
const customResolvers = new Map<string, CustomParameterResolver>();

/**
 * Registers a resolver for a custom parameter type created with
 * {@linkcode createParameterDecorator}. `current-user` resolves directly;
 * `Ctx()` uses an internal marker and also resolves directly. Application
 * custom parameter types, including one named `context`, use this registry.
 *
 * @param name - The custom parameter type name
 * @param resolver - The resolver function
 * @since 0.1.0
 */
export function registerParameterResolver(name: string, resolver: CustomParameterResolver): void {
  customResolvers.set(name, resolver);
}

/**
 * Returns the resolver registered for a custom parameter type, if any.
 *
 * @param name - The custom parameter type name
 * @returns The resolver, or `undefined`
 * @since 0.1.0
 */
export function getParameterResolver(name: string): CustomParameterResolver | undefined {
  return customResolvers.get(name);
}

/** Removes a registered custom parameter resolver (intended for tests). */
export function clearParameterResolvers(): void {
  customResolvers.clear();
}

/**
 * Parses cookies from a `Cookie` request header into a name→value record.
 *
 * Delegates to the canonical codec in `@setu-ts/common`, so the
 * framework has exactly one cookie parser (AI_GUIDELINES §11.1). That codec is
 * stricter than this function's original inline implementation in three ways,
 * each a defect fix rather than a feature: values are percent-decoded (so a
 * cookie written by any standards-compliant server round-trips), one layer of
 * RFC 6265 quoting is removed, and a repeated cookie name resolves to the first
 * occurrence rather than the last (browsers send the most specific cookie
 * first). See the CHANGELOG entry for `0.2.0`.
 *
 * @param headers - Request headers
 * @returns Parsed cookies (empty when no `Cookie` header is present)
 * @since 0.1.0
 */
export function parseCookies(headers: Headers): Record<string, string> {
  return parseCookie(headers.get('cookie'));
}

/**
 * Resolves a single parameter value from the request context. The result may
 * be a promise (for `body` and custom resolvers); callers should `await` it.
 *
 * @param ctx - The request context
 * @param param - The parameter metadata
 * @returns The resolved value (may be a promise for `body`/custom)
 * @since 0.1.0
 */
export function resolveParameter(
  ctx: IRequestContext,
  param: ParameterMetadata,
): unknown | Promise<unknown> {
  switch (param.type) {
    case 'body':
      return ctx.request.json();
    case 'query':
      return param.name !== undefined ? ctx.query[param.name] : ctx.query;
    case 'param':
      return param.name !== undefined ? ctx.params[param.name] : undefined;
    case 'header':
      return param.name !== undefined ? ctx.request.headers.get(param.name) : undefined;
    case 'cookie': {
      const cookies = parseCookies(ctx.request.headers);
      return param.name !== undefined ? cookies[param.name] : cookies;
    }
    case 'custom':
      return resolveCustom(ctx, param);
  }
}

/**
 * How a `custom` parameter will be resolved at request time. `unresolvable`
 * means no rule matches, so the handler would receive `undefined`.
 */
type CustomResolution =
  | { readonly kind: 'context' }
  | { readonly kind: 'current-user' }
  | { readonly kind: 'registered'; readonly resolver: CustomParameterResolver }
  | { readonly kind: 'unresolvable' };

/**
 * Classifies a `custom` parameter against the resolution rules. Single source
 * of truth for both request-time resolution and the startup check, so the two
 * cannot disagree about what resolves.
 */
function classifyCustom(param: ParameterMetadata): CustomResolution {
  if (isContextParameter(param.metadata)) {
    return { kind: 'context' };
  }
  if (param.customType === 'current-user') {
    return { kind: 'current-user' };
  }
  if (param.customType !== undefined) {
    const resolver = customResolvers.get(param.customType);
    if (resolver !== undefined) {
      return { kind: 'registered', resolver };
    }
  }
  return { kind: 'unresolvable' };
}

/**
 * Reports the `custom` parameters that no rule can resolve, so a caller can
 * warn about them before the first request rather than letting the handler
 * receive `undefined`.
 *
 * Reflects the resolvers registered at the moment of the call — register custom
 * resolvers before the application starts for this to be accurate.
 *
 * Internal — not exported from the package barrel.
 *
 * @param params - The handler's parameter metadata
 * @returns The unresolvable parameters, in declaration order
 */
export function findUnresolvableParameters(
  params: readonly ParameterMetadata[],
): readonly ParameterMetadata[] {
  return params.filter(
    (param) => param.type === 'custom' && classifyCustom(param).kind === 'unresolvable',
  );
}

/**
 * Resolves a custom parameter. The built-in `@Ctx()` marker and `current-user`
 * resolve directly; other types look up a resolver registered via
 * {@linkcode registerParameterResolver}.
 */
async function resolveCustom(ctx: IRequestContext, param: ParameterMetadata): Promise<unknown> {
  const resolution = classifyCustom(param);
  switch (resolution.kind) {
    case 'context':
      return ctx;
    case 'current-user':
      return ctx.request.user;
    case 'registered':
      return await resolution.resolver(ctx, param.metadata);
    case 'unresolvable':
      return undefined;
  }
}

/**
 * Resolves an ordered argument array for a handler from its parameter
 * metadata. Arguments are placed by parameter index, so undecorated
 * parameters receive `undefined`.
 *
 * @param ctx - The request context
 * @param params - The handler's parameter metadata
 * @returns The resolved arguments, indexed to match the handler signature
 * @since 0.1.0
 */
export async function resolveParameters(
  ctx: IRequestContext,
  params: readonly ParameterMetadata[],
): Promise<unknown[]> {
  const args: unknown[] = [];
  for (const param of params) {
    args[param.index] = await resolveParameter(ctx, param);
  }
  return args;
}

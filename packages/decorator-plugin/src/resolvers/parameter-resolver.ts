/**
 * Parameter resolver — maps decorator-captured {@linkcode ParameterMetadata}
 * to actual values from the {@linkcode IRequestContext} at request time.
 *
 * Used internally by the `DecoratorPlugin` when binding handler arguments;
 * exported so custom integrations can reuse the same resolution rules.
 *
 * @module
 */
import type { IRequestContext } from '@hono-enterprise/common';

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
 * {@linkcode createParameterDecorator}. The `current-user` built-in resolves
 * `ctx.request.user` and need not be registered.
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
 * @param headers - Request headers
 * @returns Parsed cookies (empty when no `Cookie` header is present)
 * @since 0.1.0
 */
export function parseCookies(headers: Headers): Record<string, string> {
  const cookieHeader = headers.get('cookie');
  if (cookieHeader === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key !== '') {
      out[key] = val;
    }
  }
  return out;
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
 * Resolves a custom parameter. `current-user` is built in; other types look
 * up a resolver registered via {@linkcode registerParameterResolver}.
 */
async function resolveCustom(ctx: IRequestContext, param: ParameterMetadata): Promise<unknown> {
  if (param.customType === 'current-user') {
    return ctx.request.user;
  }
  if (param.customType !== undefined) {
    const resolver = customResolvers.get(param.customType);
    if (resolver !== undefined) {
      return await resolver(ctx, param.metadata);
    }
  }
  return undefined;
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

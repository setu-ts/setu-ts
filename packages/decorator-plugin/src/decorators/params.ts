/**
 * Positional parameter binding for standard-decorator handlers.
 *
 * The TC39 decorator proposal has **no parameter position** — a parameter
 * decorator is a parse error, not a type error, once the legacy
 * `experimentalDecorators` compiler option is gone. Parameter injection is
 * therefore declared at the method level instead: {@linkcode Params} takes one
 * source per handler argument, in argument order.
 *
 * The sources are plain descriptors, not decorators. They carry the same
 * {@linkcode ParameterMetadata} the legacy parameter decorators stored, so
 * {@linkcode resolveParameters} and every downstream consumer are unchanged.
 *
 * Unlike the legacy form, the declaration is **type-checked against the handler
 * signature**: a source whose value type disagrees with the parameter it binds
 * is a compile error.
 *
 * @example
 * ```typescript
 * @Controller('/widgets')
 * class WidgetController {
 *   @Get('/:id')
 *   @Params(Param('id'), Query('page'))
 *   show(id: string, page: string) { … }
 * }
 * ```
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import { defer } from '../metadata/pending.ts';
import type { ParameterMetadata } from '../metadata/metadata-store.ts';
import { CONTEXT_PARAMETER_METADATA } from './security.ts';

/**
 * A declaration of where one handler argument comes from.
 *
 * `T` is the value the source resolves to; it is carried in a phantom optional
 * property so {@linkcode Params} can check each source against the handler
 * parameter it binds. The property is never read and never written at runtime.
 *
 * @since 0.2.0
 */
export interface ParamSource<T = unknown> {
  /** The metadata this source contributes, less its positional index. */
  readonly descriptor: Omit<ParameterMetadata, 'index'>;
  /** Phantom carrier for the resolved value type. Never present at runtime. */
  readonly __value?: T;
}

/**
 * Maps a tuple of sources onto the handler parameter tuple they bind.
 *
 * @since 0.2.0
 */
export type SourceValues<S extends readonly ParamSource<unknown>[]> = {
  [K in keyof S]: S[K] extends ParamSource<infer T> ? T : never;
};

/** Builds a source descriptor, omitting absent optional fields. */
function source<T>(descriptor: Omit<ParameterMetadata, 'index'>): ParamSource<T> {
  return { descriptor };
}

/**
 * Binds handler arguments to request sources, positionally.
 *
 * Each source is stored as {@linkcode ParameterMetadata} whose `index` is the
 * source's position in this call.
 *
 * The list is checked against the handler's own signature, so it must name
 * EVERY parameter — one source per argument, in argument order. A shorter or
 * longer list is a compile error rather than the silently-`undefined` argument
 * the legacy parameter decorators produced. A handler that genuinely wants
 * nothing bound simply carries no `@Params`.
 *
 * @param sources - One source per handler argument, in argument order
 * @returns A method decorator
 * @example
 * ```typescript
 * @Post('/')
 * @Params(Body<CreateWidget>(), CurrentUser<User>())
 * create(input: CreateWidget, user: User) { … }
 * ```
 * @since 0.2.0
 */
export function Params<const S extends readonly ParamSource<unknown>[]>(
  ...sources: S
): <A extends SourceValues<S>, R>(
  value: (...args: A) => R,
  context: ClassMethodDecoratorContext,
) => (...args: A) => R {
  return <A extends SourceValues<S>, R>(
    value: (...args: A) => R,
    context: ClassMethodDecoratorContext,
  ): (...args: A) => R => {
    const handler = String(context.name);
    sources.forEach((src, index) => {
      defer(context.metadata, (store, target) => {
        store.storeParam(target, handler, { ...src.descriptor, index });
      });
    });
    return value;
  };
}

/**
 * Binds the parsed JSON request body.
 *
 * Resolves to the validated body when validation middleware wrote one for this
 * request, and to the raw parsed body otherwise — so `T` is the caller's
 * declaration of what the handler expects, not a guarantee from this package.
 *
 * @returns A body source
 * @since 0.2.0
 */
export function Body<T = unknown>(): ParamSource<T> {
  return source<T>({ type: 'body' });
}

/**
 * Binds the whole query record.
 *
 * @returns A query source resolving to every query parameter
 * @since 0.2.0
 */
export function Query(): ParamSource<Readonly<Record<string, string>>>;
/**
 * Binds one named query parameter.
 *
 * @param name - Query parameter name
 * @returns A query source resolving to that parameter's value
 * @since 0.2.0
 */
export function Query<T = string>(name: string): ParamSource<T>;
export function Query<T>(name?: string): ParamSource<T> {
  return source<T>(name === undefined ? { type: 'query' } : { type: 'query', name });
}

/**
 * Binds a path parameter.
 *
 * @param name - Path parameter name; must match a `:name` route segment
 * @returns A path-parameter source
 * @since 0.2.0
 */
export function Param<T = string>(name: string): ParamSource<T> {
  return source<T>({ type: 'param', name });
}

/**
 * Binds a request header value.
 *
 * @param name - Header name
 * @returns A header source
 * @since 0.2.0
 */
export function Header(name: string): ParamSource<string | undefined> {
  return source<string | undefined>({ type: 'header', name });
}

/**
 * Binds a cookie value parsed from the `Cookie` request header.
 *
 * @param name - Cookie name
 * @returns A cookie source
 * @since 0.2.0
 */
export function Cookie(name: string): ParamSource<string | undefined> {
  return source<string | undefined>({ type: 'cookie', name });
}

/**
 * Binds the authenticated principal (`ctx.request.user`).
 *
 * @returns A principal source
 * @since 0.2.0
 */
export function CurrentUser<T = unknown>(): ParamSource<T> {
  return source<T>({ type: 'custom', customType: 'current-user' });
}

/**
 * Binds the active request context — for a handler that sets its own status
 * code, adds a header, or returns a streaming response.
 *
 * Carries the internal marker that distinguishes this built-in from an
 * application-defined custom source also named `context`.
 *
 * @returns A request-context source
 * @since 0.2.0
 */
export function Ctx(): ParamSource<IRequestContext> {
  return source<IRequestContext>({
    type: 'custom',
    customType: 'context',
    metadata: CONTEXT_PARAMETER_METADATA,
  });
}

/**
 * Binds a value produced by an application-registered resolver.
 *
 * The resolver is registered under the same `name` with
 * `registerParameterResolver`. Replaces the legacy `createParameterDecorator`,
 * which returned a parameter decorator and has no standard-decorator form.
 *
 * @param name - Custom parameter type name, matching a registered resolver
 * @param metadata - Optional payload handed to the resolver
 * @returns A custom source
 * @example
 * ```typescript
 * registerParameterResolver('tenant', (ctx) => ctx.request.tenant);
 * // …
 * @Params(Custom<Tenant>('tenant'))
 * list(tenant: Tenant) { … }
 * ```
 * @since 0.2.0
 */
export function Custom<T = unknown>(
  name: string,
  metadata?: Readonly<Record<string, unknown>>,
): ParamSource<T> {
  return source<T>(
    metadata === undefined
      ? { type: 'custom', customType: name }
      : { type: 'custom', customType: name, metadata },
  );
}

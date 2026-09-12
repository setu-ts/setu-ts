/**
 * View decorators — `@Render(Component)` attaches a view component to a
 * route, so the handler answers HTML rendered from its returned props bag
 * instead of JSON.
 *
 * The component is named BY REFERENCE: it is a function the application
 * already has, so there is no view resolver, no views directory and no
 * filesystem lookup — which is what makes the capability Workers-portable by
 * construction. The decorator is method-position only: a class-level render
 * has no meaning, because each handler returns its own props bag.
 *
 * This package resolves `CAPABILITIES.VIEW` and calls the engine behind it;
 * it deliberately imports no rendering runtime, and `Component<P>` is
 * structural, so a plain `(props) => string` function type-checks exactly
 * like a JSX component.
 *
 * @module
 * @since 0.5.0
 */
import type { Component, HandlerResult } from '@setu-ts/common';

import { methodDecorator } from '../metadata/context-bridge.ts';
import type { MetadataStore } from '../metadata/metadata-store.ts';

/**
 * The decorator `Render(Component)` returns: assignable to a handler whose
 * return is the component's props bag, sync or async, with any parameter
 * list. A handler returning the WRONG shape fails compilation naming the
 * mismatch — strictly stronger than NestJS's `@Render('users/index')`, a
 * string checked against nothing.
 *
 * @typeParam P - The decorated component's props bag
 * @since 0.5.0
 */
export type RenderDecorator<P> = (
  value: (...args: never[]) =>
    | P
    | HandlerResult
    | Promise<P | HandlerResult>,
  context: ClassMethodDecoratorContext,
) => void;

/**
 * A handler may also return a `HandlerResult` from `ctx.response` — a
 * redirect, most usefully — instead of the props bag. That is what makes
 * POST-redirect-GET expressible on a rendered route: a form handler returns
 * the props to re-render itself with errors, or `ctx.response.redirect(...)`
 * once the submission is accepted. `HandlerResult` is branded
 * (`__handlerResult: true`), so widening the union costs nothing: a props bag
 * of the wrong shape is still a compile error.
 *
 * Marks a handler as a rendered route: the method returns the component's
 * props bag, and the framework answers with the component rendered to HTML
 * (`text/html; charset=utf-8`), never JSON.
 *
 * The engine is resolved once at `register()` from `CAPABILITIES.VIEW`. A
 * rendered route in an application that registers no provider FAILS at
 * `register()`, naming the controller, the handler and both remedies — a
 * silently wrong content type (JSON where the author asked for HTML) is worse
 * than a startup refusal. The check is per route, so an application with no
 * rendered route needs no view plugin.
 *
 * A status code or header alongside a rendered body goes through `@Ctx()`:
 * the return value IS the props bag, so it cannot also carry a status, and
 * `@Render` deliberately grows no `status` argument — that would be a second
 * way to say what `@Ctx()` already says.
 *
 * @typeParam P - The component's props bag
 * @param component - The view component to render the handler's props with
 * @returns A method decorator checking the handler's return against `P`
 * @example
 * ```typescript
 * @Controller('/pages')
 * class PagesController {
 *   @Render(UserList)
 *   @Get('/')
 *   list(): { readonly users: readonly string[] } {
 *     return { users: ['ada', 'grace'] };
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export function Render<P>(component: Component<P>): RenderDecorator<P> {
  // `methodDecorator` returns `(value: unknown, context) => void`, which is
  // assignable to `RenderDecorator<P>` with no cast: the narrowed `value`
  // parameter is what adds the props checking `SetuMethodDecorator`'s
  // `unknown` cannot do.
  return methodDecorator((store: MetadataStore, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      // One component per handler: the last `@Render` to apply wins, the
      // same replace-scalar rule every other scalar metadata field follows.
      meta.view = component as Component<unknown>;
    });
  });
}

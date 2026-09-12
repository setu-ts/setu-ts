/**
 * The functional entry point, and the shared render-and-respond sequence both
 * entry points honor.
 *
 * `renderView(ctx, Component, props)` resolves `CAPABILITIES.VIEW` from the
 * request context per request — the functional generator mode has been the
 * default since M65, so the view capability is reachable without decorators —
 * and answers through the same `IResponse.html(...)` write the `@Render`
 * branch performs. One capability, one engine, every entry point honoring the
 * same configuration.
 *
 * @module
 * @since 0.5.0
 */
import type { Component, HandlerResult, IRequestContext, IViewEngine } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

/**
 * Renders a view component with the given props and writes the result as the
 * request's HTML response.
 *
 * The engine is resolved per request from `ctx.services`, so a replacement
 * provider registered under `CAPABILITIES.VIEW` is honored exactly like it is
 * for the `@Render` branch.
 *
 * @typeParam P - The component's props bag
 * @param ctx - The current kernel request context
 * @param component - The view component to render
 * @param props - The props passed to the component
 * @returns The handler result carrying the `text/html; charset=utf-8` body
 * @throws {Error} When no `CAPABILITIES.VIEW` provider is registered —
 *         register `ViewPlugin` (or any other provider of the token) first
 * @throws {ViewRenderError} When the component throws or returns a value with
 *         no string form
 * @throws {UnresolvedSuspenseError} When the tree holds a pending `<Suspense>`
 *         boundary
 * @example
 * ```typescript
 * import { renderView } from '@setu-ts/view-plugin';
 *
 * router.get('/users', (ctx) => renderView(ctx, UserList, { users }));
 * ```
 * @since 0.5.0
 */
export async function renderView<P>(
  ctx: IRequestContext,
  component: Component<P>,
  props: P,
): Promise<HandlerResult> {
  if (!ctx.services.has(CAPABILITIES.VIEW)) {
    throw new Error(
      'renderView() requires a CAPABILITIES.VIEW provider. Register ViewPlugin from ' +
        '@setu-ts/view-plugin (or any other provider of CAPABILITIES.VIEW) before serving ' +
        'rendered routes.',
    );
  }
  const engine = ctx.services.get<IViewEngine>(CAPABILITIES.VIEW);
  // The render-and-respond sequence is two lines and is deliberately NOT
  // extracted for sharing: AI_GUIDELINES §2.2 forbids `decorator-plugin`
  // importing this package, so the `@Render` branch cannot call a helper here
  // and performs the identical sequence inline. The shared implementation is
  // `IViewEngine.render` itself, which both entry points reach on the SAME
  // resolved engine — pinned byte-identically by both-entry-points.test.ts.
  return ctx.response.html(await engine.render(component, props));
}

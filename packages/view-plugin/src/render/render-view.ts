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
  return await renderToResponse(engine, ctx, component, props);
}

/**
 * The render-and-respond sequence: engine render, then the single
 * `IResponse.html(...)` write. Internal to this package — the `@Render`
 * branch in `decorator-plugin` performs the identical sequence against the
 * same resolved engine, which is what the both-entry-points integration test
 * pins byte-identically.
 *
 * @typeParam P - The component's props bag
 * @param engine - The engine resolved from `CAPABILITIES.VIEW`
 * @param ctx - The current kernel request context
 * @param component - The view component to render
 * @param props - The props passed to the component
 * @returns The handler result carrying the HTML body
 * @since 0.5.0
 */
export async function renderToResponse<P>(
  engine: IViewEngine,
  ctx: IRequestContext,
  component: Component<P>,
  props: P,
): Promise<HandlerResult> {
  const html = await engine.render(component, props);
  return ctx.response.html(html);
}

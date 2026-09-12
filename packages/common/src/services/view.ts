/**
 * View rendering contract — the port that turns a view component and its
 * props into an HTML string, served by the view plugin (`@setu-ts/view-plugin`)
 * and named by `@Render` in the decorator plugin.
 *
 * The view is named BY REFERENCE, never by path: a component is a plain
 * function the application already has, so there is no view resolver, no views
 * directory, and no filesystem lookup — which is what makes the capability
 * Workers-portable by construction. The type is structural on purpose: a JSX
 * component, an `html` tagged template closure, and a plain
 * `(props) => string` template are all `Component<P>` implementations.
 *
 * @module
 * @since 0.5.0
 */

/**
 * A view component: a pure function from a props bag to something the engine
 * can render to a string — a JSX node (`@hono/hono/jsx`), an
 * `HtmlEscapedString` (the `html` tagged template), or a plain string
 * (a by-name template adapted per §3.6 of the M92 plan).
 *
 * The return type is deliberately `unknown`: one type must cover every
 * renderable shape without this package importing a JSX runtime.
 *
 * @typeParam P - The component's props bag
 * @since 0.5.0
 */
export type Component<P> = (props: P) => unknown;

/**
 * View engine contract — renders a view component and its props to HTML.
 *
 * Registered under `CAPABILITIES.VIEW` (`'view'`). Every entry point reaches
 * the SAME engine instance: the `@Render` decorator resolves it once at
 * `register()` and the free `renderView` function resolves it per request, so
 * an application's configured engine and options govern both.
 *
 * The return is a union because an async component's render genuinely is a
 * promise — the async arm is required, not speculative.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const engine = ctx.services.get<IViewEngine>(CAPABILITIES.VIEW);
 * const html = await engine.render(UserList, { users });
 * ```
 * @since 0.5.0
 */
export interface IViewEngine {
  /**
   * Renders a view component with the given props to an HTML string.
   *
   * Interpolations are escaped by the RENDERING RUNTIME — the JSX runtime and
   * the `html` tagged template both escape — and a component opts out with
   * hono's own `raw()`, never with engine-level configuration.
   *
   * The escaping is therefore a property of how a component is WRITTEN, not a
   * guarantee this port makes. A plain `(props) => string` component is a
   * valid {@linkcode Component} and its output is returned **unchanged**:
   * correct for a by-name engine whose compiled template has already escaped
   * its own interpolations, and an XSS hole for a hand-written template
   * literal such as ``(p) => `<p>${p.name}</p>` ``. Prefer JSX or the `html`
   * tag; reach for a plain string only when the producer already escaped.
   *
   * @typeParam P - The component's props bag
   * @param component - The view component to render
   * @param props - The props passed to the component
   * @returns The rendered HTML, buffering before send — never a stream
   * @throws {Error} Implementations refuse a tree holding a pending
   *         `<Suspense>` boundary by name (buffered rendering would serve
   *         only the fallback forever) and wrap a component that throws
   * @since 0.5.0
   */
  render<P>(component: Component<P>, props: P): string | Promise<string>;
}

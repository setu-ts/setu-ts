/**
 * The default view engine arm: components authored with `@hono/hono/jsx`.
 *
 * The arm is selected with `ViewPlugin()` (no options) or
 * `ViewPlugin({ engine: 'hono-jsx' })`. Components are JSX functions — the
 * application's own manifest declares the `jsx` / `jsxImportSource`
 * compiler options, and the runtime escapes every interpolation by default,
 * with zero client JavaScript. The engine itself is rendering-runtime
 * agnostic: it invokes the component and funnels the result through the
 * shared normalization, so the JSX arm and the `html`-tag arm cannot drift
 * about escaping, async resolution or the `Suspense` refusal.
 *
 * @module
 * @since 0.5.0
 */
import type { Component, IViewEngine } from '@setu-ts/common';

import { renderComponent } from '../render/normalize.ts';

/**
 * The `'hono-jsx'` arm — the default `IViewEngine`.
 *
 * @since 0.5.0
 */
export class HonoJsxEngine implements IViewEngine {
  /**
   * Renders a JSX component and answers a primitive HTML string.
   *
   * @typeParam P - The component's props bag
   * @param component - The JSX component to render
   * @param props - The props passed to the component
   * @returns The rendered HTML
   * @since 0.5.0
   */
  render<P>(component: Component<P>, props: P): Promise<string> {
    return renderComponent(component, props);
  }
}

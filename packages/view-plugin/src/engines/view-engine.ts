/**
 * The built-in `IViewEngine` — one implementation serving both authoring
 * modes.
 *
 * `'hono-jsx'` and `'hono-html'` name how an application *writes* its
 * components, not how they are rendered: a JSX function returns a `JSXNode`,
 * an `html` tagged template returns an `HtmlEscapedString`, and both funnel
 * through the same normalization. Escaping belongs to the rendering runtime
 * (M92 §3.15), so neither mode needs engine-level configuration and there is
 * nothing left for a per-mode class to do — an earlier cut shipped two whose
 * `render` bodies were byte-identical, which is the M14d shape: a seam every
 * arm passes identically hides that the seam does nothing. One class, and the
 * option names the authoring mode (see `ViewPluginOptions`).
 *
 * @module
 * @since 0.5.0
 */
import type { Component, IViewEngine } from '@setu-ts/common';

import { renderComponent } from '../render/normalize.ts';

/**
 * Renders a view component to a primitive HTML string.
 *
 * @since 0.5.0
 */
export class ViewEngine implements IViewEngine {
  /**
   * Renders a component and answers a primitive HTML string.
   *
   * @typeParam P - The component's props bag
   * @param component - The view component to render
   * @param props - The props passed to the component
   * @returns The rendered HTML
   * @since 0.5.0
   */
  render<P>(component: Component<P>, props: P): Promise<string> {
    return renderComponent(component, props);
  }
}

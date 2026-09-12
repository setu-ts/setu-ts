/**
 * The tagged-template view engine arm: components authored with hono's `html`
 * tagged template (`@hono/hono/html`).
 *
 * The arm is selected with `ViewPlugin({ engine: 'hono-html' })`. It needs no
 * `jsxImportSource`, so components work in a plain `.ts` file — that is the
 * one ergonomic difference from the default JSX arm, and the reason it exists
 * as a second arm rather than a fallback. Interpolations are escaped by the
 * template itself; {@linkcode raw} is the documented opt-out for markup the
 * application authored on purpose.
 *
 * @module
 * @since 0.5.0
 */
import type { Component, IViewEngine } from '@setu-ts/common';
import { raw } from '@hono/hono/html';

import { renderComponent } from '../render/normalize.ts';

/**
 * Marks a string as markup the application authored on purpose, so the `html`
 * tagged template passes it through without escaping.
 *
 * Re-exported from this package's barrel so an application opting out of
 * escaping does not have to import hono directly.
 *
 * @example
 * ```typescript
 * import { html } from '@hono/hono/html';
 * import { raw } from '@setu-ts/view-plugin';
 *
 * const Snippet = (props: { readonly markup: string }) =>
 *   html`<div>${raw(props.markup)}</div>`;
 * ```
 * @since 0.5.0
 */
export { raw };

/**
 * The `'hono-html'` arm.
 *
 * @since 0.5.0
 */
export class HonoHtmlEngine implements IViewEngine {
  /**
   * Renders an `html`-tag component and answers a primitive HTML string.
   *
   * @typeParam P - The component's props bag
   * @param component - The component to render
   * @param props - The props passed to the component
   * @returns The rendered HTML
   * @since 0.5.0
   */
  render<P>(component: Component<P>, props: P): Promise<string> {
    return renderComponent(component, props);
  }
}

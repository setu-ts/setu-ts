/**
 * View rendering errors — the `instanceof` surface a consumer catches.
 *
 * Both conditions this package owns are raised as exported classes so an
 * error filter can tell them apart: a component that threw (or returned a
 * value with no string form), and a tree holding a pending `<Suspense>`
 * boundary that buffered rendering would answer with its fallback forever.
 *
 * @module
 * @since 0.5.0
 */
import type { Component } from '@setu-ts/common';

/**
 * Derives a component's display name for an error message. JSX components and
 * `const` arrow functions carry their identifier; an inline arrow does not,
 * and an anonymous name beats a message naming nothing.
 *
 * @param component - The component being rendered
 * @returns The component's function name, or an anonymous marker
 * @since 0.5.0
 */
export function componentName(component: Component<never>): string {
  return component.name !== '' ? component.name : '(anonymous component)';
}

/**
 * A view component threw while rendering, or returned a value with no string
 * form (e.g. `null`). A failure raised from a throwing component carries the
 * original as `cause`, so the underlying fault is never swallowed.
 *
 * @example
 * ```typescript
 * try {
 *   await engine.render(Page, props);
 * } catch (error) {
 *   if (error instanceof ViewRenderError) {
 *     logger.error('view render failed', { component: error.message });
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export class ViewRenderError extends Error {
  /**
   * Builds the error, naming the component in the message and forwarding any
   * original fault through the standard `cause` chain.
   *
   * @param component - The component that failed to render
   * @param reason - What went wrong, phrased to follow the component's name
   * @param options - Standard `ErrorOptions`; a throwing component passes the
   *        original error as `cause`
   */
  constructor(component: Component<never>, reason: string, options?: ErrorOptions) {
    super(`View component ${componentName(component)} ${reason}`, options);
    this.name = 'ViewRenderError';
  }
}

/**
 * A rendered tree holds a pending `<Suspense>` boundary. Buffered rendering
 * serves only the fallback — with a `200` and no error — so it is refused by
 * name instead of silently shipping a loading placeholder forever. Streaming
 * resolution is deferred to a follow-up milestone; the remedy today is to move
 * the `<Suspense>` boundary out of the rendered tree.
 *
 * @since 0.5.0
 */
export class UnresolvedSuspenseError extends Error {
  /**
   * Builds the refusal, naming the component and pointing the reader at the
   * deferred streaming milestone and the boundary-out remedy.
   *
   * @param component - The component whose rendered tree holds the boundary
   */
  constructor(component: Component<never>) {
    super(
      `View component ${componentName(component)} rendered a tree with a pending <Suspense> ` +
        `boundary. Buffering would serve only the fallback, forever, with a 200 — so it is ` +
        `refused. Move the <Suspense> boundary out of the rendered tree; streaming Suspense ` +
        `resolution is deferred to a follow-up milestone (M92b).`,
    );
    this.name = 'UnresolvedSuspenseError';
  }
}

/**
 * Rendered-value normalization — the one conversion every arm funnels through.
 *
 * Two runtime facts (measured against `@hono/hono@4.13.0`, M92 §1) make the
 * obvious implementation a silent defect, invisible to the type-checker:
 *
 * 1. `JSXNode.toString()` is statically typed `string` and returns a
 *    **Promise** at runtime whenever the tree holds an async component.
 *    Skipping the `await` emits the literal text `[object Promise]` to the
 *    browser for exactly the case the port's `Promise<string>` arm exists to
 *    serve.
 * 2. The awaited value of an async tree is a **boxed `String` object**, not a
 *    primitive — so skipping the `String(...)` hands `IResponse.html(body:
 *    string)` an object, and any consumer testing `typeof x === 'string'`
 *    gets `false` for async renders only.
 *
 * Both awaits are load-bearing and each has its own regression test
 * (`normalize.test.ts`).
 *
 * Not exported from the package barrel: this is the mechanism, not the
 * surface.
 *
 * @module
 * @since 0.5.0
 */
import type { Component } from '@setu-ts/common';
import type { HtmlEscapedString } from '@hono/hono/utils/html';

import { UnresolvedSuspenseError, ViewRenderError } from '../errors.ts';

/**
 * Converts a component's rendered value into a primitive HTML string.
 *
 * Awaits the component's own return (an async component's render genuinely is
 * a promise), answers `''` for the rendering runtime's own "render nothing"
 * values so `cond && <X/>` behaves at the top level exactly as it does nested,
 * awaits the node's `toString()` (a Promise whenever the tree holds an async
 * component), refuses a tree holding a pending `<Suspense>` boundary by name
 * (§3.3 — buffered rendering would serve only the fallback), and returns
 * `String(...)` of the result so the answer is always a **primitive** string.
 *
 * @param value - The component's return: a JSX node, an `html` tagged
 *        template result, a string, or a promise of any of these
 * @param component - The component being rendered, for error naming
 * @returns The rendered HTML as a primitive string
 * @throws {ViewRenderError} When the value is `undefined` — a component that
 *         renders nothing returns `null` or `false`, both of which yield an
 *         empty string here
 * @throws {UnresolvedSuspenseError} When the rendered tree holds a pending
 *         `<Suspense>` boundary
 * @since 0.5.0
 */
export async function normalizeRendered(
  value: unknown,
  component: Component<never>,
): Promise<string> {
  const awaited: unknown = await value;
  if (awaited === undefined) {
    throw new ViewRenderError(
      component,
      'returned undefined. A component that renders nothing returns null or false; `undefined` ' +
        'is almost always a missing `return`, so it is refused rather than served as an empty ' +
        'page.',
    );
  }
  // The rendering runtime's own "render nothing" values, matched here so a
  // top-level return behaves exactly as the same expression does nested.
  // Measured against @hono/hono@4.13.0: as a CHILD, false / true / null /
  // undefined / '' all render as nothing while 0 and NaN render their text.
  // Without this, `(p) => p.show && <Banner/>` served the four-character body
  // `false` under a 200 — the whole page being the word "false".
  if (awaited === null || awaited === false || awaited === true) {
    return '';
  }
  const text: unknown = await (awaited as { toString(): unknown }).toString();
  // The refusal signal is typed and exact (M92 §1): a sync tree carries no
  // `callbacks` at all, an async tree without `Suspense` carries an empty
  // array, and `html` with an async interpolation carries none — so `length
  // > 0` discriminates a pending `<Suspense>` boundary with no false
  // positive, which is what makes refusing safe.
  const callbacks = (text as HtmlEscapedString).callbacks;
  if (callbacks !== undefined && callbacks.length > 0) {
    throw new UnresolvedSuspenseError(component);
  }
  return String(text);
}

/**
 * Invokes a component and funnels its return through
 * {@linkcode normalizeRendered}, wrapping a component that throws —
 * synchronously or by rejecting its returned promise — in a
 * {@linkcode ViewRenderError} carrying the original as `cause`.
 *
 * Both arms are owned here rather than duplicated per engine.
 *
 * @typeParam P - The component's props bag
 * @param component - The component to invoke
 * @param props - The props passed to the component
 * @returns The rendered HTML as a primitive string
 * @throws {ViewRenderError} When the component throws or returns `undefined`
 * @throws {UnresolvedSuspenseError} When the tree holds a pending `<Suspense>`
 *         boundary (passed through unwrapped)
 * @since 0.5.0
 */
export async function renderComponent<P>(
  component: Component<P>,
  props: P,
): Promise<string> {
  let value: unknown;
  try {
    value = component(props);
  } catch (error) {
    throw new ViewRenderError(component, 'threw while rendering', { cause: error });
  }
  try {
    return await normalizeRendered(value, component);
  } catch (error) {
    if (error instanceof ViewRenderError || error instanceof UnresolvedSuspenseError) {
      throw error;
    }
    throw new ViewRenderError(component, 'threw while rendering', { cause: error });
  }
}

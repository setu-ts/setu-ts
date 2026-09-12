/**
 * A pending `<Suspense>` boundary is refused by name, never served as the
 * fallback — and the three measured non-`Suspense` shapes render clean, which
 * is the negative control that stops the refusal over-firing (M92 §3.3).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createElement as h, Suspense } from '@hono/hono/jsx';
import { html } from '@hono/hono/html';

import { ViewEngine } from '../../src/engines/view-engine.ts';
import { UnresolvedSuspenseError } from '../../src/index.ts';

/** Resolves after a tick — long after the buffered render has decided. */
async function DelayedChild() {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  return h('li', null, 'real-content');
}

/** A sync tree — carries no `callbacks` at all. */
function SyncTree() {
  return h('ul', null, h('li', null, 'ada'));
}

/** An async tree WITHOUT `Suspense` — `callbacks.length === 0`. */
function AsyncTreeWithoutSuspense() {
  return h('ul', null, h(DelayedChild, null));
}

/** A tree holding a PENDING `<Suspense>` boundary — `callbacks.length === 1`. */
function SuspenseTree() {
  return h(
    'div',
    null,
    h(Suspense, { fallback: h('p', null, 'wait') }, h(DelayedChild, null)),
  );
}

/** The `html` tagged template with an async interpolation — no `callbacks`. */
function AsyncInterpolation() {
  return html`<p>${Promise.resolve('resolved-later')}</p>`;
}

describe('pending Suspense refusal', () => {
  it('a buffered Suspense tree throws UnresolvedSuspenseError naming the component', async () => {
    const engine = new ViewEngine();

    const error = await engine.render(SuspenseTree, undefined).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnresolvedSuspenseError);
    expect((error as UnresolvedSuspenseError).message).toContain('SuspenseTree');
    // The refusal points at the deferred streaming milestone, not just at the
    // tree: an operator reading the log must learn the remedy too.
    expect((error as UnresolvedSuspenseError).message).toContain('M92b');
  });

  it('a sync tree renders clean — no over-firing', async () => {
    const result = await new ViewEngine().render(SyncTree, undefined);

    expect(typeof result).toBe('string');
    expect(result).toBe('<ul><li>ada</li></ul>');
  });

  it('an async tree without Suspense renders clean — no over-firing', async () => {
    const result = await new ViewEngine().render(AsyncTreeWithoutSuspense, undefined);

    expect(typeof result).toBe('string');
    expect(result).toContain('real-content');
  });

  it('an html template with an async interpolation renders clean — no over-firing', async () => {
    const result = await new ViewEngine().render(AsyncInterpolation, undefined);

    expect(typeof result).toBe('string');
    expect(result).toContain('resolved-later');
  });
});

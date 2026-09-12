/**
 * `normalizeRendered` — the whole conversion every arm funnels through.
 *
 * Each case asserts the RUNTIME shape (`typeof === 'string'`), not only the
 * text: `toString()` is statically typed `string` but returns a Promise for
 * any tree holding an async component, and the awaited value is a boxed
 * `String` object — so the two awaits and the `String(...)` are each
 * load-bearing and the type-checker hides all three defects (M92 §3.2).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createElement as h } from '@hono/hono/jsx';

import { normalizeRendered, renderComponent } from '../../src/render/normalize.ts';
import type { Component } from '@setu-ts/common';

/** A named sync component — error messages name it. */
function SyncPage() {
  return h('ul', null, h('li', null, 'ada'), h('li', null, 'grace'));
}

/** A named async component — its render genuinely is a promise. */
async function AsyncPage() {
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return h('p', null, 'async-body');
}

/** A sync component whose TREE nests an async child. */
function NestedAsyncPage() {
  return h('div', null, h(AsyncPage, null));
}

describe('normalizeRendered / renderComponent', () => {
  it('a sync component renders to a primitive string', async () => {
    const result = await renderComponent(SyncPage, undefined);

    expect(typeof result).toBe('string');
    expect(result).toBe('<ul><li>ada</li><li>grace</li></ul>');
    expect(result.includes('object Promise')).toBe(false);
  });

  it('an async component renders to a primitive string, never `[object Promise]`', async () => {
    const result = await renderComponent(AsyncPage, undefined);

    // The load-bearing await: toString() returns a Promise here, and skipping
    // it emits the literal text '[object Promise]'.
    expect(typeof result).toBe('string');
    expect(result).toBe('<p>async-body</p>');
    expect(result.includes('object Promise')).toBe(false);
  });

  it('a tree nesting an async child renders to a primitive string', async () => {
    const result = await renderComponent(NestedAsyncPage, undefined);

    expect(typeof result).toBe('string');
    expect(result).toBe('<div><p>async-body</p></div>');
    expect(result.includes('object Promise')).toBe(false);
  });

  it('normalizeRendered awaits the component return it is handed directly', async () => {
    const node = h('p', null, 'direct');
    const result = await normalizeRendered(Promise.resolve(node), SyncPage);

    expect(typeof result).toBe('string');
    expect(result).toBe('<p>direct</p>');
  });

  it('the boxed String the await yields is unwrapped to a primitive', async () => {
    // The awaited value of an async tree is a boxed String at runtime; the
    // String(...) conversion is what makes typeof === 'string' hold. Driven
    // here directly so the arm has its own regression test.
    const boxed = { toString: () => new String('<p>boxed</p>') };
    const result = await normalizeRendered(boxed, SyncPage);

    expect(typeof result).toBe('string');
    expect(result).toBe('<p>boxed</p>');
  });

  it('a plain (props) => string component converts unchanged', async () => {
    const component: Component<{ readonly name: string }> = (props) =>
      `<p>Hello, ${props.name}</p>`;

    expect(await renderComponent(component, { name: 'ada' })).toBe('<p>Hello, ada</p>');
  });
});

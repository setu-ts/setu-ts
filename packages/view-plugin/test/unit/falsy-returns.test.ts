/**
 * Top-level "render nothing" returns.
 *
 * A component's top-level return must behave exactly as the same expression
 * does nested, because `(p) => p.show && <Banner/>` is the most common
 * conditional idiom in JSX and its falsy branch returns `false` rather than a
 * node. An earlier cut handed every non-nullish value to `String(...)`, so
 * that branch served the four-character body `false` under a `200` — the
 * whole page being the word "false" — while the identical component nested
 * inside a parent rendered as nothing.
 *
 * Measured against `@hono/hono@4.13.0`: as a CHILD, `false` / `true` / `null`
 * / `undefined` / `''` all render as nothing, while `0` and `NaN` render
 * their text. This file pins the top level to the same set, with `undefined`
 * the one deliberate exception — it is almost always a missing `return`, so
 * it stays a named refusal rather than a silent empty page.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createElement as h } from '@hono/hono/jsx';

import { ViewEngine } from '../../src/engines/view-engine.ts';
import { ViewRenderError } from '../../src/errors.ts';
import type { Component } from '@setu-ts/common';

const engine = new ViewEngine();

/** The idiom the defect broke: a conditional whose falsy branch is `false`. */
const Banner = (props: { readonly show: boolean }) =>
  props.show && h('div', { class: 'banner' }, 'Sale');

/** The same component as a CHILD — the behaviour the top level must match. */
const Wrapped = (props: { readonly show: boolean }) =>
  h('main', null, h(Banner, { show: props.show }));

describe('top-level "render nothing" returns', () => {
  it('a false top-level return renders nothing, never the text "false"', async () => {
    const result = await engine.render(Banner, { show: false });

    expect(result).toBe('');
    expect(result).not.toContain('false');
  });

  it('agrees with the same component rendered as a child', async () => {
    const bare = await engine.render(Banner, { show: false });
    const nested = await engine.render(Wrapped, { show: false });

    // Nested, hono drops the falsy child; bare must drop it too.
    expect(nested).toBe('<main></main>');
    expect(nested).toBe(`<main>${bare}</main>`);
  });

  it('still renders the truthy branch', async () => {
    expect(await engine.render(Banner, { show: true })).toBe('<div class="banner">Sale</div>');
  });

  const nothingValues: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['false', false],
    ['true', true],
  ];
  for (const [label, value] of nothingValues) {
    it(`a ${label} top-level return renders the empty string`, async () => {
      const Nothing: Component<undefined> = () => value;

      expect(await engine.render(Nothing, undefined)).toBe('');
    });
  }

  it('renders 0 as its text, matching the runtime (0 is NOT a render-nothing value)', async () => {
    const Zero: Component<undefined> = () => 0;

    expect(await engine.render(Zero, undefined)).toBe('0');
  });

  it('still refuses undefined by name — almost always a missing `return`', async () => {
    const Forgot: Component<undefined> = () => undefined;

    await expect(engine.render(Forgot, undefined)).rejects.toThrow(ViewRenderError);
    await expect(engine.render(Forgot, undefined)).rejects.toThrow(/missing `return`/);
  });
});

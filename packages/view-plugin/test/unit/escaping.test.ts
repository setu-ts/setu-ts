/**
 * Escaping is on by default through both arms, and `raw()` is hono's own
 * opt-out, re-exported from this package's barrel (M92 §3.15). No escaping
 * logic is written in this package — the entities in the expectations are
 * written literally so an identity-replacement bug cannot hide.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { html } from '@hono/hono/html';

import { HonoJsxEngine } from '../../src/engines/hono-jsx-engine.ts';
import { HonoHtmlEngine } from '../../src/engines/hono-html-engine.ts';
import { raw } from '../../src/index.ts';
import { UserList } from '../fixtures/users.tsx';

/** An `html`-tag component authored in a plain .ts file. */
function TaggedPage(props: { readonly users: readonly string[] }) {
  return html`<ul>${props.users.map((user) => html`<li>${user}</li>`)}</ul>`;
}

describe('escaping', () => {
  it("the hono-jsx arm escapes 'Ada <script>' to literal entities", async () => {
    const result = await new HonoJsxEngine().render(UserList, {
      users: ['Ada <script>', 'Grace'],
    });

    // The entities are written with unicode escapes so the expectation
    // cannot silently decay into the raw characters it must never be.
    expect(result).toBe(
      '<ul><li>Ada \u0026lt;script\u0026gt;</li><li>Grace</li></ul>',
    );
  });

  it("the hono-html arm escapes 'Ada <script>' to literal entities", async () => {
    const result = await new HonoHtmlEngine().render(TaggedPage, {
      users: ['Ada <script>', 'Grace'],
    });

    expect(result).toBe(
      '<ul><li>Ada \u0026lt;script\u0026gt;</li><li>Grace</li></ul>',
    );
  });

  it('raw() passes markup through unescaped — the documented opt-out', () => {
    expect(String(raw('<b>bold</b>'))).toBe('<b>bold</b>');
  });
});

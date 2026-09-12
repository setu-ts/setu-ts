/**
 * The `'hono-html'` tagged-template arm.
 *
 * Renders from a PLAIN `.ts` file — the arm needs no `jsxImportSource`, which
 * is the one ergonomic difference from the default JSX arm and the reason it
 * exists as a second arm (M92 §4.1).
 *
 * @module
 */
import { ViewEngine } from '../../src/engines/view-engine.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { html } from '@hono/hono/html';

interface PageProps {
  readonly title: string;
  readonly items: readonly string[];
}

/** An ordinary function in an ordinary .ts file — no JSX, no pragma. */
function Page(props: PageProps) {
  return html`
    <h1>${props.title}</h1>
    <ul>${props.items.map((item) => html`<li>${item}</li>`)}</ul>
  `;
}

describe('ViewEngine (html-tag authoring mode)', () => {
  it('renders a tagged-template component from a plain .ts file', async () => {
    const result = await new ViewEngine().render(Page, {
      title: 'Users',
      items: ['ada', 'grace'],
    });

    expect(typeof result).toBe('string');
    // `deno fmt` reflows multi-line `html` template literals, so the markup
    // carries their whitespace; the assertion normalizes it away rather than
    // pinning a formatter's line breaks.
    expect(result.replace(/\s+/g, ' ').trim()).toBe(
      '<h1>Users</h1> <ul><li>ada</li><li>grace</li></ul>',
    );
  });
});

/**
 * Errors are exported classes — a consumer catching a render failure needs an
 * `instanceof`, and this package owns both conditions (M92 §3.18).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createElement as h } from '@hono/hono/jsx';

import { ViewEngine } from '../../src/engines/view-engine.ts';
import { renderComponent } from '../../src/render/normalize.ts';
import { UnresolvedSuspenseError, ViewRenderError } from '../../src/index.ts';

/** A named component, so the message can be asserted to name it. */
function ExplodingPage() {
  throw new Error('database is on fire');
}

/** An async component that rejects instead of throwing synchronously. */
async function RejectingPage() {
  await Promise.resolve();
  throw new Error('async fault');
}

/** A component that forgot its `return` — the one refused falsy value. */
function UndefinedPage() {
  return undefined;
}

describe('ViewRenderError', () => {
  it('a throwing component surfaces ViewRenderError with the original as cause', async () => {
    const error = await new ViewEngine().render(ExplodingPage, undefined).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ViewRenderError);
    expect((error as ViewRenderError).name).toBe('ViewRenderError');
    expect((error as ViewRenderError).message).toContain('ExplodingPage');
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe('database is on fire');
  });

  it('an async component that rejects wraps the same way', async () => {
    const error = await renderComponent(RejectingPage, undefined).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ViewRenderError);
    expect((error as ViewRenderError).message).toContain('RejectingPage');
    expect(((error as Error).cause as Error).message).toBe('async fault');
  });

  it('a component returning undefined is refused by name', async () => {
    // `null`/`false` are the deliberate "render nothing" values and yield ''
    // (falsy-returns.test.ts). `undefined` is almost always a missing
    // `return`, so it stays a named refusal rather than a silent empty page.
    const error = await new ViewEngine().render(UndefinedPage, undefined).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ViewRenderError);
    expect((error as ViewRenderError).message).toContain('UndefinedPage');
    expect((error as ViewRenderError).message).toContain('missing `return`');
  });

  it('an anonymous component is named without pretending otherwise', () => {
    const error = new ViewRenderError(() => null, 'returned null');

    expect(error.message).toContain('(anonymous component)');
  });
});

describe('UnresolvedSuspenseError', () => {
  it('carries its own name and component in the message', () => {
    function LatePage() {
      return h('p', null, 'late');
    }

    const error = new UnresolvedSuspenseError(LatePage);

    expect(error.name).toBe('UnresolvedSuspenseError');
    expect(error.message).toContain('LatePage');
    expect(error).toBeInstanceOf(Error);
  });
});

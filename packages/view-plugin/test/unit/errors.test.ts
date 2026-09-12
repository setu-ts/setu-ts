/**
 * Errors are exported classes — a consumer catching a render failure needs an
 * `instanceof`, and this package owns both conditions (M92 §3.18).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createElement as h } from '@hono/hono/jsx';

import { HonoJsxEngine } from '../../src/engines/hono-jsx-engine.ts';
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

/** A component returning a value with no string form. */
function NullPage() {
  return null;
}

describe('ViewRenderError', () => {
  it('a throwing component surfaces ViewRenderError with the original as cause', async () => {
    const error = await new HonoJsxEngine().render(ExplodingPage, undefined).then(
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

  it('a component returning null is refused by name', async () => {
    const error = await new HonoJsxEngine().render(NullPage, undefined).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ViewRenderError);
    expect((error as ViewRenderError).message).toContain('NullPage');
    expect((error as ViewRenderError).message).toContain('null');
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

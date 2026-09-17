/**
 * Tests for the route response-status brand (M97b).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RESPONSE_METADATA, responseMetadataOf, withResponseMetadata } from '../../src/index.ts';
import type { HandlerResult, IRequestContext, RouteHandler } from '../../src/index.ts';

/**
 * A distinct URL makes Deno instantiate a genuinely separate copy of the
 * module, with its own module-level constants — the same situation as two
 * copies of this package resolved into one process.
 */
const secondCopy = await import('../../src/http.ts?copy=2');
const firstCopy = await import('../../src/http.ts');

/** The brand only needs a function; the body is never invoked here. */
function handler(): RouteHandler {
  return (ctx: IRequestContext): HandlerResult => ctx.response.json({ ok: true });
}

describe('route response metadata', () => {
  it('should round-trip the status it was branded with', () => {
    expect(responseMetadataOf(withResponseMetadata(handler(), { status: 201 })))
      .toEqual({ status: 201 });
  });

  it('should return undefined for an unbranded handler', () => {
    expect(responseMetadataOf(handler())).toBeUndefined();
  });

  it('should return the SAME function reference, not a wrapper', () => {
    const original = handler();

    expect(withResponseMetadata(original, { status: 201 })).toBe(original);
  });

  it('should leave the handler callable and behaviourally unchanged', async () => {
    let called = false;
    const branded = withResponseMetadata(
      ((): HandlerResult => {
        called = true;
        return { __handlerResult: true } as HandlerResult;
      }) as RouteHandler,
      { status: 201 },
    );

    await branded({} as IRequestContext);

    expect(called).toBe(true);
  });

  it('should brand non-enumerably, so the handler still spreads and serialises', () => {
    const branded = withResponseMetadata(handler(), { status: 201 });

    expect(Object.keys(branded)).toEqual([]);
    expect(JSON.stringify({ ...branded })).toBe('{}');
    // Symbol-keyed and therefore invisible to a string-key walk, but present.
    expect(Object.getOwnPropertySymbols(branded)).toContain(RESPONSE_METADATA);
  });

  it('should accept both ends of the serveable range', () => {
    expect(responseMetadataOf(withResponseMetadata(handler(), { status: 200 })))
      .toEqual({ status: 200 });
    expect(responseMetadataOf(withResponseMetadata(handler(), { status: 599 })))
      .toEqual({ status: 599 });
  });

  it('should treat a foreign value under the same global symbol as absent', () => {
    // The guard exists because `Symbol.for` is a GLOBAL key: any library may
    // write under it. A value that is not response metadata reads as absent
    // rather than being trusted.
    for (
      const foreign of [
        'not-an-object',
        null,
        {},
        { status: '201' },
        { status: 2.5 },
        { status: Number.NaN },
        // Outside [200, 599]: the web `Response` constructor refuses these, so
        // a brand carrying one could never be honoured by any runtime.
        { status: 199 },
        { status: 600 },
        { status: 101 },
      ]
    ) {
      const fn = handler();
      Object.defineProperty(fn, RESPONSE_METADATA, { value: foreign, configurable: true });

      expect(responseMetadataOf(fn)).toBeUndefined();
    }
  });

  it('should use a global symbol, so two copies of the package agree', () => {
    // Vacuity guard first: if Deno ever deduplicated these, every assertion
    // below would prove nothing.
    expect(secondCopy).not.toBe(firstCopy);
    expect(secondCopy.withResponseMetadata).not.toBe(firstCopy.withResponseMetadata);
    expect(secondCopy.RESPONSE_METADATA).toBe(firstCopy.RESPONSE_METADATA);

    // The path an application actually takes: `decorator-plugin` resolves one
    // copy of `common` and `openapi-plugin` another. A locally-created symbol
    // would simply miss here, silently.
    const branded = secondCopy.withResponseMetadata(handler(), { status: 201 });

    expect(responseMetadataOf(branded)).toEqual({ status: 201 });
  });

  it('should NOT read a brand written under a copy-local symbol', () => {
    // The control: had the key been created with `Symbol()` rather than
    // `Symbol.for()`, every cross-copy brand would look exactly like this.
    const fn = handler();
    Object.defineProperty(fn, Symbol('setu.response.metadata'), {
      value: { status: 201 },
      configurable: true,
    });

    expect(responseMetadataOf(fn)).toBeUndefined();
  });
});

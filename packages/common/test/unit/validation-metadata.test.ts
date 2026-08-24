/**
 * Tests for the route validation metadata brand (M70m/X11-5).
 *
 * The brand is the entire channel between `@setu-ts/validation-plugin`, which
 * writes it, and `@setu-ts/openapi-plugin`, which reads it — AI_GUIDELINES
 * §2.2 forbids either importing the other. These tests pin the properties that
 * channel depends on.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  VALIDATION_METADATA,
  validationMetadataOf,
  withValidationMetadata,
} from '../../src/index.ts';
import type { MiddlewareFunction, ValidationTarget } from '../../src/index.ts';

/**
 * A genuinely separate instance of the module that owns the brand — a distinct
 * URL makes Deno instantiate its own module-level constants, which is the same
 * situation as two copies of this package resolved into one process (the M64
 * `context-marker-copies` technique).
 */
const secondCopy = await import('../../src/http.ts?copy=2');

/** A middleware that does nothing but continue — enough to be branded. */
function passthrough(): MiddlewareFunction {
  return async (_ctx, next) => {
    await next();
  };
}

const TARGETS: readonly ValidationTarget[] = [
  'body',
  'query',
  'params',
  'headers',
  'cookies',
];

describe('route validation metadata', () => {
  it('should round-trip every validation target', () => {
    for (const target of TARGETS) {
      const schema = { marker: target };
      const branded = withValidationMetadata(passthrough(), { target, schema });

      expect(validationMetadataOf(branded)).toEqual({ target, schema });
    }
  });

  it('should carry the schema by REFERENCE, not a copy', () => {
    // The reader transforms the schema with whatever schema support it has, so
    // it must receive the caller's own object — a structural clone would break
    // identity-keyed deduplication in the OpenAPI generator.
    const schema = { _def: { typeName: 'ZodString' } };
    const branded = withValidationMetadata(passthrough(), { target: 'body', schema });

    expect(validationMetadataOf(branded)?.schema).toBe(schema);
  });

  it('should return undefined for an unbranded middleware', () => {
    expect(validationMetadataOf(passthrough())).toBeUndefined();
  });

  it('should return the SAME function reference, not a wrapper', () => {
    // Identity matters: the brand must cost no wrapper frame per request, and
    // a route holds the reference the helper returned.
    const original = passthrough();

    expect(withValidationMetadata(original, { target: 'body', schema: {} })).toBe(original);
  });

  it('should hide the brand from Object.keys, spread and JSON.stringify', () => {
    const branded = withValidationMetadata(passthrough(), { target: 'query', schema: {} });

    expect(Object.keys(branded)).toEqual([]);
    expect(Object.keys({ ...branded })).toEqual([]);
    expect(JSON.stringify({ fn: branded })).toBe('{}');
  });

  it('should not change what the middleware does', async () => {
    let ran = false;
    const branded = withValidationMetadata(passthrough(), { target: 'body', schema: {} });
    await branded({} as never, () => {
      ran = true;
      return Promise.resolve();
    });

    expect(ran).toBe(true);
  });

  it('should treat a foreign value under the same global symbol as ABSENT', () => {
    // A different package could stamp anything under `Symbol.for(...)`. Reading
    // it as metadata would hand the generator a schema it never validated.
    const fn = passthrough();
    Object.defineProperty(fn, VALIDATION_METADATA, {
      value: { target: 'not-a-target', schema: {} },
      configurable: true,
    });

    expect(validationMetadataOf(fn)).toBeUndefined();
  });

  it('should reject a non-object brand value', () => {
    const fn = passthrough();
    Object.defineProperty(fn, VALIDATION_METADATA, { value: 'body', configurable: true });

    expect(validationMetadataOf(fn)).toBeUndefined();
  });

  it('should reject a null brand value', () => {
    const fn = passthrough();
    Object.defineProperty(fn, VALIDATION_METADATA, { value: null, configurable: true });

    expect(validationMetadataOf(fn)).toBeUndefined();
  });

  it('should use a GLOBAL symbol, so two copies of this package agree', () => {
    // `Symbol()` would miss on every read when two copies share a process —
    // the failure M37c hit with hand-written React Router context keys, and
    // the reason M57's SECURITY_METADATA uses `Symbol.for` too.
    expect(VALIDATION_METADATA).toBe(Symbol.for('setu.validation.metadata'));
  });

  it('really is a separate module copy', () => {
    // Vacuity guard for the test below: if Deno ever deduplicated these, the
    // cross-copy assertion would prove nothing.
    expect(secondCopy.withValidationMetadata).not.toBe(withValidationMetadata);
    expect(secondCopy.VALIDATION_METADATA).toBe(VALIDATION_METADATA);
  });

  it('should be readable through a SEPARATE module instance of this package', () => {
    // The real cross-copy case: two instances of `common` in one process,
    // which is what a duplicated dependency produces. Branded by one, read by
    // the other — the property `Symbol.for` buys and `Symbol()` would lose.
    const schema = { _def: { typeName: 'ZodObject' } };
    const branded = secondCopy.withValidationMetadata(passthrough(), { target: 'body', schema });

    expect(validationMetadataOf(branded)).toEqual({ target: 'body', schema });
  });

  it('rejects a value carrying a target but no schema (PR #181 review)', () => {
    // `schema` must be PRESENT, not merely declared by the type: a foreign
    // value branded under the same key otherwise read back as valid metadata,
    // and the OpenAPI generator counted that as a derivation.
    const fn: MiddlewareFunction = async (_ctx, next) => {
      await next();
    };
    Object.defineProperty(fn, VALIDATION_METADATA, { value: { target: 'body' } });

    expect(validationMetadataOf(fn)).toBeUndefined();
  });

  it('accepts an explicitly undefined schema, which is a legal unknown', () => {
    const fn: MiddlewareFunction = async (_ctx, next) => {
      await next();
    };
    Object.defineProperty(fn, VALIDATION_METADATA, {
      value: { target: 'body', schema: undefined },
    });

    expect(validationMetadataOf(fn)?.target).toBe('body');
  });
});

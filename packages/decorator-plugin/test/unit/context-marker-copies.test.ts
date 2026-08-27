import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeRequestContext } from '../fixtures/fake-request-context.ts';
import {
  CONTEXT_PARAMETER_METADATA,
  isContextParameter,
  PARAMETER_KIND_KEY,
} from '../../src/decorators/security.ts';
import { resolveParameter } from '../../src/resolvers/parameter-resolver.ts';

/**
 * A distinct URL makes Deno instantiate a genuinely separate copy of the
 * module, with its own module-level constants — the same situation as two
 * copies of this package resolved into one process.
 */
const secondCopy = await import('../../src/decorators/security.ts?copy=2');
const firstCopy = await import('../../src/decorators/security.ts');
/** The `Ctx()` SOURCE lives in params.ts; a second copy of it must interoperate too. */
const secondParams = await import('../../src/decorators/params.ts?copy=2');

describe('@Ctx marker across package copies', () => {
  it('really is a separate module copy', () => {
    // Guards the tests below from passing vacuously: if Deno ever deduplicated
    // these, the cross-copy assertions would prove nothing.
    expect(secondCopy).not.toBe(firstCopy);
    expect(secondCopy.isContextParameter).not.toBe(firstCopy.isContextParameter);
    expect(secondCopy.CONTEXT_PARAMETER_METADATA).not.toBe(CONTEXT_PARAMETER_METADATA);
  });

  it('recognises metadata attached by another copy of the package', () => {
    expect(isContextParameter(secondCopy.CONTEXT_PARAMETER_METADATA)).toBe(true);
  });

  it("recognises a Ctx() source built by another copy's params module", () => {
    // The path an application actually takes: it imports Ctx from one copy and
    // a starter runs DecoratorPlugin from another. Recognition is by marker
    // VALUE (Symbol.for), so it survives the crossing.
    expect(isContextParameter(secondParams.Ctx().descriptor.metadata)).toBe(true);
  });

  it("resolves another copy's @Ctx parameter to the live request context", async () => {
    const ctx = createFakeRequestContext();
    expect(
      await resolveParameter(ctx, {
        index: 0,
        type: 'custom',
        customType: 'context',
        metadata: secondCopy.CONTEXT_PARAMETER_METADATA,
      }),
    ).toBe(ctx);
  });

  it('rejects an application object that merely reuses the marker key', () => {
    expect(isContextParameter(Object.freeze({ [PARAMETER_KIND_KEY]: 'context' }))).toBe(false);
    expect(isContextParameter(Object.freeze({}))).toBe(false);
    expect(isContextParameter(undefined)).toBe(false);
  });

  it('rejects a copy-local Symbol, proving recognition depends on Symbol.for', () => {
    // The control: had the marker been created with Symbol() rather than
    // Symbol.for(), a second copy's marker would look exactly like this.
    const copyLocal = Object.freeze({
      [PARAMETER_KIND_KEY]: Symbol('@setu-ts/decorator-plugin:context'),
    });
    expect(isContextParameter(copyLocal)).toBe(false);
  });
});

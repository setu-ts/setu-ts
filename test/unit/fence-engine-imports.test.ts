/**
 * Regression tests for `importsIdentifier` — the fence engine's decision about
 * whether a documentation fence already imports a name.
 *
 * The answer drives prelude emission: a name reported as NOT imported gets a
 * `declare`/`import type` line synthesised for it. Both failure directions are
 * real and both have shipped:
 *
 * - reporting an un-imported name as imported suppresses the declaration, so
 *   the fence fails with "Cannot find name";
 * - reporting an imported name as un-imported emits a competing declaration,
 *   so the fence fails with a duplicate identifier.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { importsIdentifier } from '../fixtures/snippets/fence-engine.ts';

describe('importsIdentifier', () => {
  it('matches a plain specifier exactly', () => {
    const code = "import { CAPABILITIES } from '@setu-ts/common';";
    expect(importsIdentifier(code, 'CAPABILITIES')).toBe(true);
    expect(importsIdentifier(code, 'CAPABILITIE')).toBe(false);
  });

  it('does not treat a longer specifier as importing its prefix', () => {
    // PR #183 review: a substring test reported `Inject` as imported by a
    // block importing only `Injectable`, suppressing its prelude declaration.
    const code = "import { Injectable } from '@setu-ts/decorator-plugin';";
    expect(importsIdentifier(code, 'Injectable')).toBe(true);
    expect(importsIdentifier(code, 'Inject')).toBe(false);
  });

  it('resolves an inline `type` modifier to the bare name', () => {
    // PR #183 review: without stripping the modifier the name reads as
    // `type IMessageBroker`, so the prelude emits a second import for it.
    const code = "import { CAPABILITIES, type IMessageBroker } from '@setu-ts/common';";
    expect(importsIdentifier(code, 'IMessageBroker')).toBe(true);
    expect(importsIdentifier(code, 'CAPABILITIES')).toBe(true);
  });

  it('resolves several inline type specifiers in one block', () => {
    const code = "import { CAPABILITIES, type ILogger, type IPlugin } from '@setu-ts/common';";
    for (const name of ['CAPABILITIES', 'ILogger', 'IPlugin']) {
      expect(importsIdentifier(code, name)).toBe(true);
    }
  });

  it('binds an alias, not the original name', () => {
    const code = "import { Foo as Bar } from '@setu-ts/common';";
    expect(importsIdentifier(code, 'Bar')).toBe(true);
    expect(importsIdentifier(code, 'Foo')).toBe(false);
  });

  it('binds an aliased inline type import to the alias', () => {
    // Modifier stripping must run BEFORE alias resolution, or the local
    // binding comes out as `type Foo as Bar`.
    const code = "import { type Foo as Bar } from '@setu-ts/common';";
    expect(importsIdentifier(code, 'Bar')).toBe(true);
    expect(importsIdentifier(code, 'Foo')).toBe(false);
  });

  it('handles a block-level type import', () => {
    const code = "import type { IRequestContext } from '@setu-ts/common';";
    expect(importsIdentifier(code, 'IRequestContext')).toBe(true);
  });

  it('reports a name no import block mentions', () => {
    const code = "import { CAPABILITIES } from '@setu-ts/common';\nconst x = IRequest;";
    expect(importsIdentifier(code, 'IRequest')).toBe(false);
  });
});

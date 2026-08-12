/**
 * Tests for the class-based template's DI wiring.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DI_WIRING } from '../../../src/templates/di.ts';
import { CLASS_BASED_PLUGINS } from '../../../src/templates/class-based.ts';

describe('DI_WIRING', () => {
  it('names the package and symbol the generated config imports', () => {
    expect(DI_WIRING).toEqual({ pkg: 'di-plugin', symbol: 'DiPlugin' });
  });

  it('carries no args, because the DiPlugin options parameter is optional', () => {
    // `DiPlugin(options?: DiPluginOptions)` — a bare `DiPlugin()` type-checks,
    // so an args string would be text with nothing to say.
    expect(DI_WIRING.args).toBeUndefined();
  });
});

describe('class-based composition', () => {
  it('installs DI exactly once with the decorator plugin', () => {
    expect(CLASS_BASED_PLUGINS.filter((wiring) => wiring.pkg === 'di-plugin')).toEqual([
      DI_WIRING,
    ]);
    expect(CLASS_BASED_PLUGINS.some((wiring) => wiring.pkg === 'decorator-plugin')).toBe(true);
  });
});

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
    expect(DI_WIRING.pkg).toBe('di-plugin');
    expect(DI_WIRING.symbol).toBe('DiPlugin');
  });

  it('emits autoRegister: true, because the default disables the container', () => {
    // `autoRegister` defaults to `false`, and both the external resolver and the
    // registry fallback are gated on it — a bare `DiPlugin()` makes every
    // `@Inject(CAPABILITIES.X)` throw at startup. E3.
    expect(DI_WIRING.args).toBe('{ autoRegister: true }');
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

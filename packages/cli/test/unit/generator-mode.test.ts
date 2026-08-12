import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generatorMode } from '../../src/utils/generator-mode.ts';

describe('generatorMode', () => {
  it('selects functional generation without the decorator plugin', () => {
    expect(generatorMode(new Set())).toBe('functional');
    expect(generatorMode(new Set(['di-plugin']))).toBe('functional');
  });

  it('retains class-based generation for projects with decorators', () => {
    expect(generatorMode(new Set(['decorator-plugin']))).toBe('class-based');
    expect(generatorMode(new Set(['decorator-plugin', 'di-plugin']))).toBe('class-based');
  });
});

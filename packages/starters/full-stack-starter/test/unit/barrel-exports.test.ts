/**
 * @module full-stack-starter barrel export tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as fullStackStarter from '../../src/index.ts';

describe('full-stack-starter / barrel exports', () => {
  it('exports exactly the three factories', () => {
    const exportedNames = Object.keys(fullStackStarter);
    expect(new Set(exportedNames)).toEqual(
      new Set([
        'createFullStackApp',
        'buildFullStackPlugins',
        'createFullStackAppFromConfig',
      ]),
    );
  });

  it('createFullStackAppFromConfig is a function', () => {
    expect(typeof fullStackStarter.createFullStackAppFromConfig).toBe('function');
  });

  it('createsFullStackApp is a function', () => {
    expect(typeof fullStackStarter.createFullStackApp).toBe('function');
  });

  it('buildFullStackPlugins is a function', () => {
    expect(typeof fullStackStarter.buildFullStackPlugins).toBe('function');
  });

  it('FullStackStarterOptions is a type (undefined at runtime)', () => {
    const fullStackStarterAny = fullStackStarter as Record<string, unknown>;
    expect(fullStackStarterAny['FullStackStarterOptions']).toBeUndefined();
  });
});

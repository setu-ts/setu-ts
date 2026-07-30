/**
 * @module full-stack-starter barrel export tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as fullStackStarter from '../src/index.ts';

describe('full-stack-starter / barrel exports', () => {
  it('exports exactly createFullStackApp, FullStackStarterOptions, buildFullStackPlugins', () => {
    const exportedNames = Object.keys(fullStackStarter);
    expect(exportedNames).toEqual([
      'createFullStackApp',
      'FullStackStarterOptions',
      'buildFullStackPlugins',
    ]);
  });

  it('createsFullStackApp is a function', () => {
    expect(typeof fullStackStarter.createFullStackApp).toBe('function');
  });

  it('buildFullStackPlugins is a function', () => {
    expect(typeof fullStackStarter.buildFullStackPlugins).toBe('function');
  });

  it('FullStackStarterOptions is a type (undefined at runtime)', () => {
    expect(fullStackStarter.FullStackStarterOptions).toBeUndefined();
  });
});

/**
 * @module rest-starter barrel export tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as restStarter from '../../src/index.ts';

describe('rest-starter / barrel exports', () => {
  it('exports exactly createRestApp and buildRestPlugins', () => {
    const exportedNames = Object.keys(restStarter);
    // Use set comparison regardless of order
    expect(new Set(exportedNames)).toEqual(
      new Set([
        'createRestApp',
        'buildRestPlugins',
      ]),
    );
  });

  it('createsRestApp is a function', () => {
    expect(typeof restStarter.createRestApp).toBe('function');
  });

  it('buildRestPlugins is a function', () => {
    expect(typeof restStarter.buildRestPlugins).toBe('function');
  });
});

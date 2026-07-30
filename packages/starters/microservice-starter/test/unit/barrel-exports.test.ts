/**
 * @module microservice-starter barrel export tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as microserviceStarter from '../../src/index.ts';

describe('microservice-starter / barrel exports', () => {
  it('exports exactly createMicroserviceApp and buildMicroservicePlugins', () => {
    const exportedNames = Object.keys(microserviceStarter);
    expect(new Set(exportedNames)).toEqual(
      new Set([
        'createMicroserviceApp',
        'buildMicroservicePlugins',
      ]),
    );
  });

  it('createsMicroserviceApp is a function', () => {
    expect(typeof microserviceStarter.createMicroserviceApp).toBe('function');
  });

  it('buildMicroservicePlugins is a function', () => {
    expect(typeof microserviceStarter.buildMicroservicePlugins).toBe('function');
  });

  it('MicroserviceStarterOptions is a type (undefined at runtime)', () => {
    const microserviceStarterAny = microserviceStarter as Record<string, unknown>;
    expect(microserviceStarterAny['MicroserviceStarterOptions']).toBeUndefined();
  });
});

import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller, Version } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('@Controller / @Version', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('stores the base path', () => {
    @Controller('/users')
    class UserController {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(UserController)?.path).toBe('/users');
    expect(metadataStore.hasController(UserController)).toBe(true);
  });

  it('stores the version prefix', () => {
    @Controller('/users')
    @Version('v1')
    class UserController {
      @Get('/')
      list() {
        return [];
      }
    }
    const meta = metadataStore.getController(UserController);
    expect(meta?.path).toBe('/users');
    expect(meta?.version).toBe('v1');
  });

  it('last @Controller call wins for path', () => {
    @Controller('/second')
    @Controller('/first')
    class UserController {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(UserController)?.path).toBe('/second');
  });

  it('works without @Controller (route still stored, no controller metadata)', () => {
    class BareController {
      @Get('/health')
      health() {
        return 'ok';
      }
    }
    expect(metadataStore.getController(BareController)).toBeUndefined();
    const routes = metadataStore.getRoutesFor(BareController);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/health');
  });
});

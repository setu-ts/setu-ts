import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Delete, Get, Head, Options, Patch, Post, Put } from '../../src/decorators/http.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('HTTP method decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('registers a GET route with the given path', () => {
    @Controller('/users')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    const routes = metadataStore.getRoutesFor(C);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/', handler: 'list' });
  });

  it('defaults the path to empty string when omitted', () => {
    @Controller('/users')
    class C {
      @Get()
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].path).toBe('');
  });

  it('registers each HTTP verb', () => {
    @Controller('/r')
    class C {
      @Get('/g')
      get() {
        return 'g';
      }
      @Post('/p')
      post() {
        return 'p';
      }
      @Put('/u')
      put() {
        return 'u';
      }
      @Patch('/pa')
      patch() {
        return 'pa';
      }
      @Delete('/d')
      del() {
        return 'd';
      }
      @Head('/h')
      head() {
        return 'h';
      }
      @Options('/o')
      opts() {
        return 'o';
      }
    }
    const routes = metadataStore.getRoutesFor(C);
    expect(routes.map((r) => r.method).sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    );
  });

  it('multiple HTTP decorators on the same method produce multiple routes', () => {
    @Controller('/items')
    class C {
      @Get('/:id')
      @Head('/:id')
      get() {
        return null;
      }
    }
    const routes = metadataStore.getRoutesFor(C);
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.handler === 'get')).toBe(true);
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'HEAD']);
  });
});

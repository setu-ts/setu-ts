import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import { ApiOperation, ApiResponse, ApiTags } from '../../src/decorators/openapi.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('OpenAPI decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('@ApiTags stores tags on the controller', () => {
    @Controller('/x')
    @ApiTags('users', 'admin')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.tags).toEqual(['users', 'admin']);
  });

  it('@ApiOperation stores operation metadata on the route', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @ApiOperation({ operationId: 'listUsers', summary: 'List users' })
      list() {
        return [];
      }
    }
    const oa = metadataStore.getRoutesFor(C)[0].openapi;
    expect(oa?.operationId).toBe('listUsers');
    expect(oa?.summary).toBe('List users');
  });

  it('@ApiResponse stores a response entry', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @ApiResponse({ status: 200, description: 'ok' })
      list() {
        return [];
      }
    }
    const oa = metadataStore.getRoutesFor(C)[0].openapi;
    expect(oa?.responses?.['200']).toMatchObject({ description: 'ok' });
  });

  it('multiple @ApiResponse accumulate', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @ApiResponse({ status: 200, description: 'ok' })
      @ApiResponse({ status: 404, description: 'missing' })
      list() {
        return [];
      }
    }
    const responses = metadataStore.getRoutesFor(C)[0].openapi?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['200', '404']);
  });

  it('@ApiResponse without description/schema stores an empty entry', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @ApiResponse({ status: 204 })
      list() {
        return [];
      }
    }
    const responses = metadataStore.getRoutesFor(C)[0].openapi?.responses ?? {};
    expect(responses['204']).toEqual({});
  });
});

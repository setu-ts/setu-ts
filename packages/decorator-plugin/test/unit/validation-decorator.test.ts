import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Post } from '../../src/decorators/http.ts';
import { Body } from '../../src/decorators/request.ts';
import { ValidateBody, ValidateParams, ValidateQuery } from '../../src/decorators/validation.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

const bodySchema = { type: 'object', properties: { name: { type: 'string' } } };
const querySchema = { type: 'object', properties: { page: { type: 'number' } } };
const paramsSchema = { type: 'object', properties: { id: { type: 'string' } } };

describe('Validation decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('@ValidateBody stores the schema on route.schema.body', () => {
    @Controller('/x')
    class C {
      @Post('/')
      @ValidateBody(bodySchema)
      create(@Body() body: unknown) {
        return body;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].schema?.body).toBe(bodySchema);
  });

  it('@ValidateQuery stores the schema on route.schema.query', () => {
    @Controller('/x')
    class C {
      @Post('/')
      @ValidateQuery(querySchema)
      create() {
        return null;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].schema?.query).toBe(querySchema);
  });

  it('@ValidateParams stores the schema on route.schema.params', () => {
    @Controller('/x')
    class C {
      @Post('/:id')
      @ValidateParams(paramsSchema)
      create() {
        return null;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].schema?.params).toBe(paramsSchema);
  });

  it('multiple validation decorators combine on the same route', () => {
    @Controller('/x')
    class C {
      @Post('/:id')
      @ValidateBody(bodySchema)
      @ValidateQuery(querySchema)
      @ValidateParams(paramsSchema)
      create() {
        return null;
      }
    }
    const schema = metadataStore.getRoutesFor(C)[0].schema;
    expect(schema?.body).toBe(bodySchema);
    expect(schema?.query).toBe(querySchema);
    expect(schema?.params).toBe(paramsSchema);
  });
});

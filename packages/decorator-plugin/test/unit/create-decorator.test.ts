import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import { createDecorator, createParameterDecorator } from '../../src/decorators/custom.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('createDecorator / createParameterDecorator', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('createDecorator stores a class-level custom decorator record', () => {
    @createDecorator('cache:cacheable', { ttl: 60 })
    class C {}

    const records = metadataStore.getCustomDecorators();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'cache:cacheable', metadata: { ttl: 60 } });
    expect(records[0].propertyKey).toBeUndefined();
    expect(records[0].target).toBe(C);
  });

  it('createDecorator stores a method-level custom decorator record', () => {
    class C {
      @createDecorator('cache:cacheable', { ttl: 30 })
      list() {
        return [];
      }
    }

    const records = metadataStore.getCustomDecorators();
    expect(records).toHaveLength(1);
    expect(records[0].propertyKey).toBe('list');
    expect(records[0].target).toBe(C);
  });

  it('createParameterDecorator stores a custom parameter', () => {
    @Controller('/x')
    class C {
      @Get('/')
      me(@createParameterDecorator('current-tenant') t: unknown) {
        return t;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p).toMatchObject({ type: 'custom', customType: 'current-tenant' });
    expect(p.metadata).toBeUndefined();
  });

  it('createParameterDecorator stores the metadata payload', () => {
    @Controller('/x')
    class C {
      @Get('/')
      me(@createParameterDecorator('tenant', { scope: 'org' }) t: unknown) {
        return t;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.metadata).toEqual({ scope: 'org' });
  });
});

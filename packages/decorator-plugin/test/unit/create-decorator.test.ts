import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import { createDecorator } from '../../src/decorators/custom.ts';
import { Custom, Params } from '../../src/decorators/params.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('createDecorator / Custom', () => {
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
    @Controller('/x')
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

  it("surfaces a bare class's method-level record once the class is read", () => {
    // A standard member decorator never receives the constructor, so its write
    // is drained when the STORE reads that class. `getCustomDecorators()` takes
    // no class, so a method-level record on a class carrying no class decorator
    // at all is not in the global list until something reads the class itself.
    //
    // No functional impact: the plugin only replays custom decorators for
    // classes it registers, and registering one reads it per-target first. This
    // pins the boundary rather than leaving it to be discovered.
    class Bare {
      @createDecorator('cache:cacheable', { ttl: 30 })
      list() {
        return [];
      }
    }

    expect(metadataStore.getCustomDecorators()).toHaveLength(0);
    metadataStore.getRoutesFor(Bare);
    const records = metadataStore.getCustomDecorators();
    expect(records).toHaveLength(1);
    expect(records[0].target).toBe(Bare);
  });

  it('Custom stores a custom parameter', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Custom('current-tenant'))
      me(t: unknown) {
        return t;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p).toMatchObject({ type: 'custom', customType: 'current-tenant' });
    expect(p.metadata).toBeUndefined();
  });

  it('Custom stores the metadata payload', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Custom('tenant', { scope: 'org' }))
      me(t: unknown) {
        return t;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.metadata).toEqual({ scope: 'org' });
  });
});

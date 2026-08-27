import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import {
  Body,
  Cookie,
  Ctx,
  CurrentUser,
  Custom,
  Header,
  Param,
  Params,
  Query,
} from '../../src/decorators/params.ts';
import { isContextParameter } from '../../src/decorators/security.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('@Params positional binding', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('stores one record per source, indexed by argument position', () => {
    @Controller('/x')
    class C {
      @Post('/:id')
      @Params(Param('id'), Body(), Query('page'))
      create(_id: string, _body: unknown, _page: string): void {}
    }
    const params = metadataStore.getRoutesFor(C)[0].params;
    expect(params).toHaveLength(3);
    expect(params[0]).toMatchObject({ index: 0, type: 'param', name: 'id' });
    expect(params[1]).toMatchObject({ index: 1, type: 'body' });
    expect(params[2]).toMatchObject({ index: 2, type: 'query', name: 'page' });
  });

  it('stores sources in ASCENDING index order', () => {
    // The legacy parameter decorators evaluated in reverse argument order, so
    // the store held these descending. Order is not load-bearing —
    // `resolveParameters` places each argument by `param.index` — but the
    // change is deliberate, so it is pinned rather than left incidental.
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Param('a'), Param('b'), Param('c'))
      list(_a: string, _b: string, _c: string): void {}
    }
    const indices = metadataStore.getRoutesFor(C)[0].params.map((p) => p.index);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('omits `name` for a bare @Query rather than storing undefined', () => {
    // exactOptionalPropertyTypes: an absent optional field must be absent, not
    // present-and-undefined, or the stored shape stops matching the baseline.
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Query())
      list(_all: Readonly<Record<string, string>>): void {}
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.type).toBe('query');
    expect(Object.hasOwn(p, 'name')).toBe(false);
  });

  it('binds header and cookie sources by name', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Header('x-trace'), Cookie('sid'))
      list(_t: string | undefined, _s: string | undefined): void {}
    }
    const params = metadataStore.getRoutesFor(C)[0].params;
    expect(params[0]).toMatchObject({ index: 0, type: 'header', name: 'x-trace' });
    expect(params[1]).toMatchObject({ index: 1, type: 'cookie', name: 'sid' });
  });

  it('binds the principal as a custom source', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Params(CurrentUser())
      list(_u: unknown): void {}
    }
    expect(metadataStore.getRoutesFor(C)[0].params[0]).toMatchObject({
      index: 0,
      type: 'custom',
      customType: 'current-user',
    });
  });

  it('Ctx() carries the built-in context marker', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Ctx())
      list(_c: unknown): void {}
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.customType).toBe('context');
    // Recognition is by marker VALUE, never by the metadata object's identity.
    expect(isContextParameter(p.metadata)).toBe(true);
  });

  it('Custom() carries its resolver name and payload, and omits an absent payload', () => {
    @Controller('/x')
    class C {
      @Get('/a')
      @Params(Custom('tenant', { scope: 'request' }))
      withPayload(_t: unknown): void {}

      @Get('/b')
      @Params(Custom('tenant'))
      without(_t: unknown): void {}
    }
    const routes = metadataStore.getRoutesFor(C);
    const a = routes.find((r) => r.path === '/a')?.params[0];
    const b = routes.find((r) => r.path === '/b')?.params[0];
    expect(a).toMatchObject({
      type: 'custom',
      customType: 'tenant',
      metadata: { scope: 'request' },
    });
    expect(b?.customType).toBe('tenant');
    expect(Object.hasOwn(b as object, 'metadata')).toBe(false);
  });

  it('an application-defined custom source is NOT mistaken for the built-in Ctx()', () => {
    // A consumer may legitimately name its own source `context`; only the
    // built-in carries the marker.
    @Controller('/x')
    class C {
      @Get('/')
      @Params(Custom('context'))
      list(_c: unknown): void {}
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.customType).toBe('context');
    expect(isContextParameter(p.metadata)).toBe(false);
  });

  it('a handler with no @Params records no parameters', () => {
    @Controller('/x')
    class C {
      @Get('/')
      list(): void {}
    }
    expect(metadataStore.getRoutesFor(C)[0].params).toHaveLength(0);
  });

  it('shares one @Params declaration across both verbs on a multi-verb handler', () => {
    @Controller('/x')
    class C {
      @Get('/:id')
      @Post('/:id')
      @Params(Param('id'))
      both(_id: string): void {}
    }
    const routes = metadataStore.getRoutesFor(C);
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.params).toEqual([{ index: 0, type: 'param', name: 'id' }]);
    }
  });
});

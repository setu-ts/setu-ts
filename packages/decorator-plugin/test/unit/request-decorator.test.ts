import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Post } from '../../src/decorators/http.ts';
import { Body, Cookie, Header, Param, Query } from '../../src/decorators/request.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('Request parameter decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('@Body stores a body parameter at its index', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Body() body: unknown) {
        return body;
      }
    }
    const params = metadataStore.getRoutesFor(C)[0].params;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ index: 0, type: 'body' });
    expect(params[0].name).toBeUndefined();
  });

  it('@Query(name) stores a named query parameter', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Query('q') q: string) {
        return q;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].params[0]).toMatchObject({
      index: 0,
      type: 'query',
      name: 'q',
    });
  });

  it('@Query() without a name stores the whole query object', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Query() q: Record<string, string>) {
        return q;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p.type).toBe('query');
    expect(p.name).toBeUndefined();
  });

  it('@Param stores a path parameter', () => {
    @Controller('/x')
    class C {
      @Post('/:id')
      create(@Param('id') id: string) {
        return id;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].params[0]).toMatchObject({
      index: 0,
      type: 'param',
      name: 'id',
    });
  });

  it('@Header stores a header parameter', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Header('x-request-id') rid: string) {
        return rid;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].params[0]).toMatchObject({
      index: 0,
      type: 'header',
      name: 'x-request-id',
    });
  });

  it('@Cookie stores a cookie parameter', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Cookie('session') session: string) {
        return session;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].params[0]).toMatchObject({
      index: 0,
      type: 'cookie',
      name: 'session',
    });
  });

  it('preserves parameter indices across multiple decorated params', () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Body() body: unknown, @Query('q') q: string, @Header('h') h: string) {
        return { body, q, h };
      }
    }
    const params = metadataStore.getRoutesFor(C)[0].params;
    const byIndex = new Map(params.map((p) => [p.index, p]));
    expect(byIndex.get(0)?.type).toBe('body');
    expect(byIndex.get(1)?.type).toBe('query');
    expect(byIndex.get(2)?.type).toBe('header');
    expect(params.map((p) => p.index).sort()).toEqual([0, 1, 2]);
  });
});

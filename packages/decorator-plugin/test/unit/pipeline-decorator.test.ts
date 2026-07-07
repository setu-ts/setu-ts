import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HandlerResult,
  IMiddleware,
  IRequestContext,
  MiddlewareFunction,
  NextFunction,
} from '@hono-enterprise/common';

import { Controller } from '../../src/decorators/controller.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import { UseFilters, UseGuards, UseInterceptors } from '../../src/decorators/pipeline.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

const guardFn: MiddlewareFunction = () => {};
const interceptorFn: MiddlewareFunction = () => {};
const filterFn: MiddlewareFunction = () => {};

class GuardClass implements IMiddleware {
  handle(): void | HandlerResult | Promise<void | HandlerResult> {
    return;
  }
}

class InterceptorClass implements IMiddleware {
  handle(
    _ctx: IRequestContext,
    _next: NextFunction,
  ): void | HandlerResult | Promise<void | HandlerResult> {
    return;
  }
}

describe('Pipeline decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('@UseGuards appends guards at the method level', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @UseGuards(guardFn)
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].guards).toHaveLength(1);
  });

  it('@UseGuards accepts an IMiddleware class', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @UseGuards(GuardClass)
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].guards).toHaveLength(1);
  });

  it('@UseInterceptors stores interceptors at the method level', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @UseInterceptors(interceptorFn, InterceptorClass)
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].interceptors).toHaveLength(2);
  });

  it('@UseFilters stores filters at the method level', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @UseFilters(filterFn)
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].filters).toHaveLength(1);
  });

  it('class-level @UseGuards applies to the controller', () => {
    @Controller('/x')
    @UseGuards(guardFn)
    class C {
      @Get('/a')
      a() {
        return 1;
      }
      @Post('/b')
      b() {
        return 2;
      }
    }
    expect(metadataStore.getController(C)?.guards).toHaveLength(1);
  });

  it('class- and method-level guards are both stored (merged at registration)', () => {
    @Controller('/x')
    @UseGuards(guardFn)
    class C {
      @Get('/')
      @UseGuards(guardFn, GuardClass)
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.guards).toHaveLength(1);
    expect(metadataStore.getRoutesFor(C)[0].guards).toHaveLength(2);
  });

  it('class-level @UseFilters is supported', () => {
    @Controller('/x')
    @UseFilters(filterFn)
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.filters).toHaveLength(1);
  });

  it('class-level @UseInterceptors is supported', () => {
    @Controller('/x')
    @UseInterceptors(interceptorFn)
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.interceptors).toHaveLength(1);
  });

  it('class-level @UseInterceptors with IMiddleware class', () => {
    @Controller('/x')
    @UseInterceptors(InterceptorClass)
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.interceptors).toHaveLength(1);
  });

  it('method-level @UseInterceptors on Post', () => {
    @Controller('/x')
    class C {
      @Post('/')
      @UseInterceptors(interceptorFn)
      create() {
        return 1;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].interceptors).toHaveLength(1);
  });

  it('method-level @UseFilters on Post', () => {
    @Controller('/x')
    class C {
      @Post('/')
      @UseFilters(filterFn)
      create() {
        return 1;
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].filters).toHaveLength(1);
  });
});

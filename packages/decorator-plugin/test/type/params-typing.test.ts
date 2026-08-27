import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import { Body, Ctx, Custom, Param, Params, Query } from '../../src/decorators/params.ts';
import type { IRequestContext } from '@setu-ts/common';

/**
 * The legacy parameter decorators type-checked NOTHING about the handler they
 * bound — `@Param('id') id: number` was accepted and failed at runtime. The
 * positional form checks each source against the parameter it binds, and these
 * `@ts-expect-error` controls are what prove it: an unused directive is itself
 * a compile error, so each one fails `deno check` the moment the check weakens.
 */
describe('@Params type checking', () => {
  it('accepts a declaration whose sources match the handler signature', () => {
    interface NewWidget {
      name: string;
    }

    @Controller('/x')
    class C {
      @Post('/:id')
      @Params(Param('id'), Body<NewWidget>(), Ctx())
      create(id: string, input: NewWidget, ctx: IRequestContext): string {
        return `${id}${input.name}${typeof ctx}`;
      }

      @Get('/')
      @Params(Query(), Custom<{ id: string }>('tenant'))
      list(all: Readonly<Record<string, string>>, tenant: { id: string }): string {
        return `${Object.keys(all).length}${tenant.id}`;
      }
    }
    expect(typeof C).toBe('function');
  });

  it('rejects a parameter whose type disagrees with its source', () => {
    @Controller('/x')
    class C {
      @Get('/:id')
      // @ts-expect-error Param('id') resolves to string, not number.
      @Params(Param('id'))
      show(_id: number): void {}
    }
    expect(typeof C).toBe('function');
  });

  it('rejects a body source bound to an incompatible parameter', () => {
    interface NewWidget {
      name: string;
    }

    @Controller('/x')
    class C {
      @Post('/')
      // @ts-expect-error Body<NewWidget>() does not satisfy a `number` parameter.
      @Params(Body<NewWidget>())
      create(_input: number): void {}
    }
    expect(typeof C).toBe('function');
  });

  it('rejects fewer sources than the handler has parameters', () => {
    // The list must name EVERY parameter. The legacy form left an undecorated
    // parameter silently `undefined` at runtime; this is a compile error, and
    // the JSDoc on `Params` says so.
    @Controller('/x')
    class C {
      @Get('/:id')
      // @ts-expect-error one source declared, two parameters to bind.
      @Params(Param('id'))
      show(_id: string, _page: string): void {}
    }
    expect(typeof C).toBe('function');
  });

  it('rejects more sources than the handler has parameters', () => {
    @Controller('/x')
    class C {
      @Get('/')
      // @ts-expect-error two sources declared, one parameter to bind them to.
      @Params(Param('a'), Param('b'))
      list(_a: string): void {}
    }
    expect(typeof C).toBe('function');
  });
});

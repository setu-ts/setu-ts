/**
 * WHERE the declared shaping is written, not merely what it ends up as
 * (M97b §3.1).
 *
 * `response-shaping.test.ts` asserts the final status, and a test that asserts
 * only the final status passes whether the write lands before or after the
 * handler method. These cases discriminate: a handler reading
 * `ctx.response.snapshot().status` observes the decorator's value only if the
 * write happened FIRST, and that same ordering is what lets the handler's own
 * `status(202)` win. Moving the write to after `method(...)` fails both.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IRequestContext } from '@setu-ts/common';

import {
  Controller,
  Ctx,
  DecoratorPlugin,
  Get,
  HttpCode,
  Params,
  Redirect,
  ResponseHeader,
} from '../../src/index.ts';

@Controller('/order')
class OrderObservingController {
  @HttpCode(201)
  @Params(Ctx())
  @Get('/status')
  status(ctx: IRequestContext): { readonly seen: number } {
    return { seen: ctx.response.snapshot().status };
  }

  @ResponseHeader('X-Declared', 'yes')
  @Params(Ctx())
  @Get('/header')
  header(ctx: IRequestContext): { readonly seen: string | null } {
    return { seen: ctx.response.snapshot().headers.get('x-declared') };
  }

  @Redirect('/order/v2', 307)
  @Params(Ctx())
  @Get('/redirect')
  redirect(ctx: IRequestContext): { readonly status: number; readonly location: string | null } {
    const snapshot = ctx.response.snapshot();
    return { status: snapshot.status, location: snapshot.headers.get('location') };
  }
}

describe('response shaping is written before the handler method runs', () => {
  it('the handler observes the @HttpCode status while it is still running', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [OrderObservingController] }),
      ],
    });
    try {
      const res = await app.fetch(new Request('http://local/order/status'));

      // `seen` is what the handler read; the outer status is what was served.
      // Both are 201 only because the write precedes the method.
      expect(await res.json()).toEqual({ seen: 201 });
      expect(res.status).toBe(201);
    } finally {
      await app.stop();
    }
  });

  it('the handler observes a declared @ResponseHeader while it is still running', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [OrderObservingController] }),
      ],
    });
    try {
      const res = await app.fetch(new Request('http://local/order/header'));

      expect(await res.json()).toEqual({ seen: 'yes' });
    } finally {
      await app.stop();
    }
  });

  it('the handler observes a declared @Redirect while it is still running', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [OrderObservingController] }),
      ],
    });
    try {
      const res = await app.fetch(new Request('http://local/order/redirect'));

      expect(await res.json()).toEqual({ status: 307, location: '/order/v2' });
    } finally {
      await app.stop();
    }
  });
});

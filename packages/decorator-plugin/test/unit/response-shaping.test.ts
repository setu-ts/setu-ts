/**
 * `@HttpCode`, `@ResponseHeader` and `@Redirect` — what each one writes, and
 * what beats what (M97b §3.1, §3.2, §3.3).
 *
 * Driven through `app.fetch` rather than `inject()`, so every assertion reads
 * what a served request reads. That is load-bearing for the `204` case and not
 * merely tidy: `inject()` does not go through `mapSnapshotToWebResponse`, so
 * the same route reports `204 {"dropped":3}` there and `204 ""` through
 * `app.fetch` — measured. Written against `inject()`, the bodiless assertion
 * would pass while asserting the opposite of what a client sees.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { Constructor, IRequestContext } from '@setu-ts/common';

import {
  Controller,
  Ctx,
  DecoratorPlugin,
  Get,
  HttpCode,
  Params,
  Post,
  Redirect,
  ResponseHeader,
} from '../../src/index.ts';

/** Boots an application whose only routes come from `controller`. */
async function appWith(controller: Constructor): Promise<IKernelApplication> {
  return await createTestApp({
    plugins: [RuntimePlugin(), DecoratorPlugin({ controllers: [controller] })],
  });
}

/** Issues one request through the real fetch entry point. */
function call(
  app: IKernelApplication,
  method: string,
  path: string,
): Promise<Response> {
  return app.fetch(new Request(`http://local${path}`, { method }));
}

@Controller('/shaped')
class ShapedController {
  @HttpCode(201)
  @Post('/created')
  created(): { readonly id: string } {
    return { id: 'o-1' };
  }

  @HttpCode(204)
  @Post('/purged')
  purged(): { readonly dropped: number } {
    return { dropped: 3 };
  }

  @ResponseHeader('Cache-Control', 'no-store')
  @ResponseHeader('X-Report-Version', '3')
  @Get('/headers')
  headers(): { readonly ok: true } {
    return { ok: true };
  }

  @Redirect('/shaped/v2', 301)
  @Get('/v1')
  legacy(): { readonly ranBody: true } {
    return { ranBody: true };
  }

  @Redirect('/shaped/v2')
  @Get('/default-redirect')
  defaultRedirect(): { readonly ok: true } {
    return { ok: true };
  }

  @HttpCode(201)
  @Params(Ctx())
  @Post('/explicit')
  explicit(ctx: IRequestContext): unknown {
    return ctx.response.status(202).json({ explicit: true });
  }

  @HttpCode(201)
  @ResponseHeader('X-Combined', 'yes')
  @Post('/combined')
  combined(): { readonly ok: true } {
    return { ok: true };
  }

  @Get('/plain')
  plain(): { readonly ok: true } {
    return { ok: true };
  }
}

describe('response-shaping decorators', () => {
  it('@HttpCode sets the success status for a plain return', async () => {
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'POST', '/shaped/created');

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: 'o-1' });
    } finally {
      await app.stop();
    }
  });

  it('@HttpCode(204) answers a bodiless 204 rather than throwing', async () => {
    // Pins the citation rather than asserting it: the runtime's snapshot
    // mapping drops a body written at a null-body status, so this package needs
    // no guard of its own. It fails if that mapper guard is ever removed —
    // before it existed, a body at 204 threw `TypeError: Response with null
    // body status cannot have body` out of `app.fetch`. `inject()` never
    // reaches that mapper, which is why this case is driven through `fetch`.
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'POST', '/shaped/purged');

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
    } finally {
      await app.stop();
    }
  });

  it('@ResponseHeader writes every declared header', async () => {
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'GET', '/shaped/headers');

      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-report-version')).toBe('3');
      expect(res.status).toBe(200);
      await res.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('@Redirect sets the status and Location, and the handler body still ran', async () => {
    // §3.3: a decorator cannot decline to call the method, so `@Redirect` does
    // NOT short-circuit — and the plugin does not pretend otherwise. The body
    // is proof the handler ran.
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'GET', '/shaped/v1');

      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/shaped/v2');
      expect(await res.json()).toEqual({ ranBody: true });
    } finally {
      await app.stop();
    }
  });

  it('@Redirect defaults to 302, matching IResponse.redirect', async () => {
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'GET', '/shaped/default-redirect');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/shaped/v2');
      await res.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('a returned HandlerResult wins over @HttpCode', async () => {
    // §3.2: the explicit runtime value is the more specific statement. This
    // falls out of §3.1's ordering — the decorator writes to the builder, then
    // the handler's own call overwrites it — rather than from a comparison.
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'POST', '/shaped/explicit');

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ explicit: true });
    } finally {
      await app.stop();
    }
  });

  it('@HttpCode and @ResponseHeader compose on one handler', async () => {
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'POST', '/shaped/combined');

      expect(res.status).toBe(201);
      expect(res.headers.get('x-combined')).toBe('yes');
      await res.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('an undecorated handler is unchanged — still 200, still JSON', async () => {
    const app = await appWith(ShapedController);
    try {
      const res = await call(app, 'GET', '/shaped/plain');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });
});

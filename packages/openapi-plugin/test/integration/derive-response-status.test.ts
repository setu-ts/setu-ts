/**
 * Derived success statuses, driven through a REAL kernel application with the
 * REAL `@setu-ts/decorator-plugin` (M97b §3.5, §3.6, §3.7, §3.8).
 *
 * A hand-branded handler cannot prove the one property the whole channel rests
 * on: that `decorator-plugin` and `openapi-plugin` resolve the same
 * `Symbol.for` key without either importing the other. Only a real app can.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { withResponseMetadata } from '@setu-ts/common';
import {
  ApiResponse,
  Controller,
  DecoratorPlugin,
  Get,
  HttpCode,
  Post,
  Redirect,
  ResponseHeader,
} from '@setu-ts/decorator-plugin';
import type { Constructor } from '@setu-ts/common';

import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import type { OpenApiDocument } from '../../src/generators/openapi-generator.ts';
import type { OpenApiPluginOptions } from '../../src/plugin/openapi-plugin.ts';

@Controller('/orders')
class OrderController {
  @HttpCode(201)
  @Post('/')
  create(): { readonly id: string } {
    return { id: 'o-1' };
  }

  @HttpCode(204)
  @Post('/purge')
  purge(): { readonly dropped: number } {
    return { dropped: 3 };
  }

  @HttpCode(201)
  @ApiResponse({ status: 200, description: 'Declared wins' })
  @Post('/declared')
  declared(): { readonly ok: true } {
    return { ok: true };
  }

  @Redirect('/orders', 301)
  @Get('/v1')
  legacy(): { readonly moved: true } {
    return { moved: true };
  }

  @ResponseHeader('Cache-Control', 'no-store')
  @Get('/latest')
  latest(): { readonly ok: true } {
    return { ok: true };
  }
}

@Controller('/plain')
class PlainController {
  @Get('/')
  list(): readonly string[] {
    return [];
  }

  @Post('/')
  create(): { readonly ok: true } {
    return { ok: true };
  }
}

/** Builds the document a real application serves from its own spec endpoint. */
async function specFrom(
  controller: Constructor,
  options: OpenApiPluginOptions = { title: 'Orders', version: '1.0.0' },
): Promise<OpenApiDocument> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DecoratorPlugin({ controllers: [controller] }),
      OpenApiPlugin(options),
    ],
  });
  await app.start();
  try {
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    return await res.json() as OpenApiDocument;
  } finally {
    await app.stop();
  }
}

describe('derived response status through a real application', () => {
  it('documents the status the handler declared, not the assumed 200', async () => {
    const spec = await specFrom(OrderController as Constructor);

    // The whole channel: `decorator-plugin` brands the HANDLER,
    // `openapi-plugin` reads it off `RouteInfo.definition.handler`, and neither
    // imports the other. A locally-created symbol on either side would leave
    // this documented as `200`.
    expect(spec.paths['/orders']?.post?.responses).toEqual({
      '201': { description: 'Resource created' },
    });
    expect(spec.paths['/orders/purge']?.post?.responses).toEqual({
      '204': { description: 'No content' },
    });
  });

  it('documents a @Redirect route under its 3xx', async () => {
    const spec = await specFrom(OrderController as Constructor);

    expect(spec.paths['/orders/v1']?.get?.responses).toEqual({
      '301': { description: 'Moved permanently' },
    });
  });

  it('a DECLARED response map wins over the derived status', async () => {
    // Precedence mirrors `deriveSecurity` exactly: declared beats derived.
    const spec = await specFrom(OrderController as Constructor);

    expect(spec.paths['/orders/declared']?.post?.responses).toEqual({
      '200': { description: 'Declared wins' },
    });
  });

  it('derives nothing from @ResponseHeader — no headers object is emitted', async () => {
    // §3.7: an OpenAPI response-header entry needs a schema and a description
    // the decorator does not carry, so it is deliberately not derived.
    const spec = await specFrom(OrderController as Constructor);
    const operation = spec.paths['/orders/latest']?.get;

    expect(operation?.responses).toEqual({ '200': { description: 'Successful response' } });
    expect(JSON.stringify(operation)).not.toContain('headers');
  });

  it('deriveResponseStatus: false reproduces the pre-derivation document', async () => {
    const off = await specFrom(OrderController as Constructor, {
      title: 'Orders',
      version: '1.0.0',
      deriveResponseStatus: false,
    });

    // Every derived route falls back to the assumed 200 — which is exactly the
    // document this generator produced before the derivation existed.
    expect(off.paths['/orders']?.post?.responses).toEqual({
      '200': { description: 'Successful response' },
    });
    expect(off.paths['/orders/purge']?.post?.responses).toEqual({
      '200': { description: 'Successful response' },
    });
    expect(off.paths['/orders/v1']?.get?.responses).toEqual({
      '200': { description: 'Successful response' },
    });
    // A declared map was never derived, so it is untouched by the switch.
    expect(off.paths['/orders/declared']?.post?.responses).toEqual({
      '200': { description: 'Declared wins' },
    });
  });

  it('an application declaring no response shaping is byte-identical either way', async () => {
    // This is what makes defaulting the option ON safe: the brand is new
    // surface, so no handler written before it existed carries one. An
    // application that changes nothing gets exactly the document it got before.
    const on = await specFrom(PlainController as Constructor);
    const off = await specFrom(PlainController as Constructor, {
      title: 'Orders',
      version: '1.0.0',
      deriveResponseStatus: false,
    });

    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.paths['/plain']?.get?.responses).toEqual({
      '200': { description: 'Successful response' },
    });
  });

  it('derives from a handler branded OUTSIDE decorator-plugin', async () => {
    // `RESPONSE_METADATA` is exported and `PUBLIC_API.md` says so: "the symbol
    // is exported so a handler produced outside `@setu-ts/decorator-plugin` can
    // be branded too". Nothing drove that claim, so this does — a programmatic
    // route, no decorators anywhere.
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'P', version: '1.0.0' })],
    });
    app.router.post('/things', {
      handler: withResponseMetadata(
        (ctx) => ctx.response.status(201).json({ id: 1 }),
        { status: 201 },
      ),
    });
    app.router.get('/things', { handler: (ctx) => ctx.response.json([]) });
    await app.start();
    try {
      const res = await app.fetch(new Request('http://localhost/openapi.json'));
      const spec = await res.json() as OpenApiDocument;

      expect(spec.paths['/things']?.post?.responses).toEqual({
        '201': { description: 'Resource created' },
      });
      // The control: an unbranded handler beside it keeps the assumed 200, so
      // the assertion above cannot pass by the derivation being unconditional.
      expect(spec.paths['/things']?.get?.responses).toEqual({
        '200': { description: 'Successful response' },
      });
    } finally {
      await app.stop();
    }
  });

  it('the option reaches the generator through the PLUGIN, not only the generator', async () => {
    // `OpenApiPluginOptions extends OpenApiGeneratorOptions`, so the option
    // type-checks on the plugin whether or not it is threaded — the M70i
    // dropped-argument class. The assertion above proves it is: with the
    // option dropped somewhere in the chain, `deriveResponseStatus: false`
    // would still derive and that case would fail. This one pins the default.
    const spec = await specFrom(OrderController as Constructor, {
      title: 'Orders',
      version: '1.0.0',
      deriveResponseStatus: true,
    });

    expect(spec.paths['/orders']?.post?.responses).toEqual({
      '201': { description: 'Resource created' },
    });
  });
});

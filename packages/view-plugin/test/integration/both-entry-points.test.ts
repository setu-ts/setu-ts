/**
 * Both entry points, one implementation (M92 §3.10).
 *
 * One real kernel application under the NON-default `engine: 'hono-html'`
 * configuration serves a decorated route (`@Render`) and a functional route
 * (`renderView`) and asserts byte-identical bodies and headers — the test
 * that keeps a helper from hardcoding a default while the service honors
 * configured options.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { Controller, DecoratorPlugin, Get, Render } from '@setu-ts/decorator-plugin';
import { html } from '@hono/hono/html';
import type { IRequestContext } from '@setu-ts/common';

import { renderView, ViewPlugin } from '../../src/index.ts';

interface PageProps {
  readonly title: string;
}

/** The component BOTH entry points render — authored with the html template. */
const UsersPage = (props: PageProps) => html`<h1>${props.title}</h1>`;

@Controller('/pages')
class PagesController {
  @Render(UsersPage)
  @Get('/decorated')
  decorated(): PageProps {
    return { title: 'Users' };
  }
}

async function createAppUnderTest() {
  const app = await createTestApp({
    plugins: [
      RuntimePlugin(),
      // The NON-default arm: a helper hardcoding 'hono-jsx' would pass every
      // other test and fail this one.
      ViewPlugin({ engine: 'hono-html' }),
      DecoratorPlugin({ controllers: [PagesController] }),
    ],
  });
  app.router.get('/pages/functional', (ctx) => renderView(ctx, UsersPage, { title: 'Users' }));
  return app;
}

describe('both entry points under a non-default configuration', () => {
  it('renderView refuses by name when no CAPABILITIES.VIEW provider is registered', async () => {
    const ctx = { services: { has: () => false } } as unknown as IRequestContext;

    await expect(renderView(ctx, UsersPage, { title: 'Users' })).rejects.toThrow(
      /CAPABILITIES\.VIEW/,
    );
  });

  it('a decorated route and a functional route answer byte-identically', async () => {
    const app = await createAppUnderTest();

    const decorated = await inject(app, '/pages/decorated');
    const functional = await inject(app, '/pages/functional');

    expect(decorated.statusCode).toBe(200);
    expect(functional.statusCode).toBe(200);
    expect(decorated.body).toBe('<h1>Users</h1>');
    expect(decorated.body).toBe(functional.body);
    expect(decorated.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(decorated.headers.get('content-type')).toBe(
      functional.headers.get('content-type'),
    );
    await app.stop();
  });
});

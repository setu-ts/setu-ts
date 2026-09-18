/**
 * `@Render` composed with the response-shaping decorators (M97b §3.1).
 *
 * The render branch answers `ctx.response.html(...)`, and the shaping is
 * written onto the builder BEFORE the handler runs — so a rendered `201` needs
 * no special case in the render path, and neither does a rendered route
 * carrying a header. Driven through `app.fetch` so every assertion reads what a
 * served request reads.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';
import type { IKernelApplication } from '@setu-ts/kernel';

import {
  Controller,
  DecoratorPlugin,
  Get,
  HttpCode,
  Post,
  Redirect,
  Render,
  ResponseHeader,
} from '../../src/index.ts';

interface UserListProps {
  readonly users: readonly string[];
}

const UserList = (props: UserListProps): string =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/pages')
class PagesController {
  @HttpCode(201)
  @Render(UserList)
  @Post('/users')
  create(): UserListProps {
    return { users: ['ada'] };
  }

  @ResponseHeader('Cache-Control', 'no-store')
  @Render(UserList)
  @Get('/users')
  list(): UserListProps {
    return { users: ['ada', 'grace'] };
  }

  @Redirect('/pages/users', 303)
  @Render(UserList)
  @Post('/moved')
  moved(): UserListProps {
    return { users: [] };
  }
}

/** Boots the app both plugins need. */
function boot(): Promise<IKernelApplication> {
  return createTestApp({
    plugins: [
      RuntimePlugin(),
      ViewPlugin(),
      DecoratorPlugin({ controllers: [PagesController] }),
    ],
  });
}

describe('@Render composed with response shaping', () => {
  it('answers the declared status with the rendered HTML body', async () => {
    const app = await boot();
    try {
      const res = await app.fetch(
        new Request('http://local/pages/users', { method: 'POST' }),
      );

      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toBe('<ul><li>ada</li></ul>');
    } finally {
      await app.stop();
    }
  });

  it('answers a declared header with the rendered HTML body', async () => {
    const app = await boot();
    try {
      const res = await app.fetch(new Request('http://local/pages/users'));

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('<ul><li>ada</li><li>grace</li></ul>');
    } finally {
      await app.stop();
    }
  });

  it('a rendered route may declare a redirect, and still renders its body', async () => {
    // `@Redirect` does not short-circuit (§3.3), so the render branch still
    // runs — the response carries both the redirect status and the HTML.
    const app = await boot();
    try {
      const res = await app.fetch(
        new Request('http://local/pages/moved', { method: 'POST' }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/pages/users');
      expect(await res.text()).toBe('<ul></ul>');
    } finally {
      await app.stop();
    }
  });
});

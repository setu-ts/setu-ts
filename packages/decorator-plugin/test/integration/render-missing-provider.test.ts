/**
 * A rendered route with no `CAPABILITIES.VIEW` provider fails at `register()`
 * (M92 §3.8) — naming the controller, the handler, and both remedies — while
 * the control (a controller carrying no `@Render`) starts clean with no view
 * plugin, because the check is per route.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

import { Controller, DecoratorPlugin, Get, Render } from '../../src/index.ts';

interface UserListProps {
  readonly users: readonly string[];
}

const UserList = (props: UserListProps): string =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/orphans')
class RenderedController {
  @Render(UserList)
  @Get('/users')
  users(): UserListProps {
    return { users: ['ada'] };
  }
}

@Controller('/plain')
class PlainController {
  @Get('/health-check')
  plain(): { readonly ok: boolean } {
    return { ok: true };
  }
}

describe('a rendered route with no view provider', () => {
  it('fails at register(), naming controller, handler and both remedies', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        // No ViewPlugin — the rendered route must refuse to start.
        DecoratorPlugin({ controllers: [RenderedController] }),
      ],
      autoStart: false,
    });

    const error = await app.start().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('@Render');
    expect(message).toContain('RenderedController');
    expect(message).toContain('users');
    expect(message).toContain('ViewPlugin');
    expect(message).toContain('CAPABILITIES.VIEW');
  });

  it('a controller carrying no @Render starts clean with no view plugin', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [PlainController] }),
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/plain/health-check' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await app.stop();
  });
});

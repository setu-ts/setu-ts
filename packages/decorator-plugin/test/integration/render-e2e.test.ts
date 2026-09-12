/**
 * The rendered route, end to end (M92 §3.9, §3.17).
 *
 * A real application with both plugins registered in BOTH orders serves a
 * rendered route from each — the assertion that would have caught M90i's P1,
 * where an `optionalDependencies` edge added in the opposite direction made
 * every application registering both plugins throw `Circular plugin
 * dependency detected` at `start()`. The body is HTML under
 * `text/html; charset=utf-8`, never JSON; a route sets `201` through `@Ctx()`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';

import { Controller, Ctx, DecoratorPlugin, Get, Params, Render } from '../../src/index.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext, IRequestContext, IViewEngine } from '@setu-ts/common';

interface UserListProps {
  readonly users: readonly string[];
}

const UserList = (props: UserListProps): string =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/pages')
class PagesController {
  @Render(UserList)
  @Get('/users')
  users(): UserListProps {
    return { users: ['ada', 'grace'] };
  }

  @Render(UserList)
  @Params(Ctx())
  @Get('/created')
  created(ctx: IRequestContext): UserListProps {
    ctx.response.status(201);
    return { users: ['new'] };
  }
}

/**
 * A replacement provider at the LOWEST priority, registered after
 * `DecoratorPlugin` in the array. The `optionalDependencies` edge is what
 * still orders it before the decorator; priority alone would not (the M45b
 * finding, which the M92 plan's negative control 4 assumed away).
 */
function LateViewPlugin(): IPlugin {
  const engine: IViewEngine = { render: (component, props) => String(component(props)) };
  return {
    name: 'late-view',
    version: '0.0.0',
    provides: [CAPABILITIES.VIEW],
    priority: PLUGIN_PRIORITY.LOWEST,
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.VIEW, engine);
    },
  };
}

describe('a rendered route end to end, in both registration orders', () => {
  it('a replacement provider at the LOWEST priority still registers before the decorator', async () => {
    // Without the optionalDependencies edge, resolution would order by
    // priority — decorator (LOW, 900) before late-view (LOWEST, 1000) — and
    // the decorator's register-time read would find no VIEW provider and
    // refuse the application. The edge is what makes the resolution a
    // contract rather than priority luck.
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [PagesController] }),
        LateViewPlugin(),
      ],
    });

    const response = await inject(app, '/pages/users');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<ul><li>ada</li><li>grace</li></ul>');
    await app.stop();
  });

  it('boots and serves with ViewPlugin registered before DecoratorPlugin', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        ViewPlugin(),
        DecoratorPlugin({ controllers: [PagesController] }),
      ],
    });

    const response = await inject(app, '/pages/users');
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<ul><li>ada</li><li>grace</li></ul>');
    await app.stop();
  });

  it('boots and serves with DecoratorPlugin registered before ViewPlugin', async () => {
    // The M90i P1 shape: a reversed registration array must not throw
    // `Circular plugin dependency detected` at start(), and the rendered
    // route must still reach the engine.
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [PagesController] }),
        ViewPlugin(),
      ],
    });

    const response = await inject(app, '/pages/users');
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<ul><li>ada</li><li>grace</li></ul>');
    await app.stop();
  });

  it('answers HTML, never JSON, for the decorated route', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), ViewPlugin(), DecoratorPlugin({ controllers: [PagesController] })],
    });

    const response = await inject(app, '/pages/users');

    expect(response.headers.get('content-type')).not.toContain('application/json');
    expect(response.body?.startsWith('<ul>')).toBe(true);
    await app.stop();
  });

  it('a route sets 201 through @Ctx() and keeps its rendered body', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), ViewPlugin(), DecoratorPlugin({ controllers: [PagesController] })],
    });

    const response = await inject(app, '/pages/created');

    expect(response.statusCode).toBe(201);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<ul><li>new</li></ul>');
    await app.stop();
  });
});

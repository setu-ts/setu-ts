/**
 * A rendered route answering with a redirect instead of its props.
 *
 * POST-redirect-GET is the standard form pattern: the handler re-renders
 * itself carrying validation errors, or redirects once the submission is
 * accepted, so a refresh does not resubmit. `createHandler` checks
 * `isHandlerResult(result)` BEFORE the render branch, so the redirect must
 * short-circuit — no HTML body, and the `Location` header intact.
 *
 * Driven through a real kernel application with `app.fetch`, never
 * `inject()`, because `inject()` exposes no response headers (M51) and
 * `Location` is the whole assertion.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';

import { Controller, Ctx, DecoratorPlugin, Get, Params, Post, Render } from '../../src/index.ts';

interface FormProps {
  readonly values: { readonly title: string };
  readonly errors: Readonly<Record<string, string>>;
}

const TaskForm = (props: FormProps): string =>
  `<form data-error="${props.errors.title ?? ''}">${props.values.title}</form>`;

@Controller('/tasks')
class TasksController {
  @Render(TaskForm)
  @Params(Ctx())
  @Post('/')
  submit(ctx: IRequestContext): FormProps | HandlerResult {
    // `?ok` stands in for "validation passed".
    if (ctx.request.url.includes('ok')) {
      return ctx.response.redirect('/tasks', 303);
    }
    return { values: { title: 'ab' }, errors: { title: 'too short' } };
  }

  @Render(TaskForm)
  @Get('/new')
  blank(): FormProps {
    return { values: { title: '' }, errors: {} };
  }
}

function buildApp() {
  return createApplication({
    plugins: [RuntimePlugin(), ViewPlugin(), DecoratorPlugin({ controllers: [TasksController] })],
  });
}

describe('a rendered route returning a HandlerResult', () => {
  it('redirects without rendering, keeping the Location header', async () => {
    const app = buildApp();
    await app.start();

    const res = await app.fetch(new Request('http://localhost/tasks?ok', { method: 'POST' }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/tasks');
    // The render branch must not have run: no HTML body.
    expect(await res.text()).toBe('');
    await app.stop();
  });

  it('renders the props bag when the handler returns one instead', async () => {
    const app = buildApp();
    await app.start();

    const res = await app.fetch(new Request('http://localhost/tasks', { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<form data-error="too short">ab</form>');
    await app.stop();
  });

  it('leaves an ordinary rendered GET untouched', async () => {
    const app = buildApp();
    await app.start();

    const res = await app.fetch(new Request('http://localhost/tasks/new'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<form data-error=""></form>');
    await app.stop();
  });
});

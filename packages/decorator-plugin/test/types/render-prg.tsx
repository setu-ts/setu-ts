/**
 * `@Render` handlers and POST-redirect-GET (compile-time).
 *
 * A form handler must be able to answer two ways: the props bag, to re-render
 * itself carrying validation errors, or a redirect once the submission is
 * accepted. The runtime always supported this — `createHandler` checks
 * `isHandlerResult(result)` before rendering — but the decorator's type
 * constrained the return to `P | Promise<P>`, so the standard form pattern
 * was a `TS1241` compile error while working perfectly at runtime.
 *
 * Widening to include `HandlerResult` costs nothing, because it is branded
 * (`__handlerResult: true` in `common/src/http.ts`): the wrong-props case
 * below is STILL an error, and the `@ts-expect-error` is self-validating — if
 * widening had collapsed the check, this file would fail to compile because
 * the directive would be unused.
 *
 * @module
 */
import type { HandlerResult, IRequestContext } from '@setu-ts/common';

import { Controller, Ctx, Get, Params, Post, Render } from '../../src/index.ts';

interface FormProps {
  readonly values: { readonly title: string };
  readonly errors: Readonly<Record<string, string>>;
}

const TaskForm = (props: FormProps): string => `<form>${props.values.title}</form>`;

@Controller('/tasks')
export class TasksController {
  @Render(TaskForm)
  @Get('/new')
  blank(): FormProps {
    return { values: { title: '' }, errors: {} };
  }

  /** The form pattern: re-render with errors, or redirect on success. */
  @Render(TaskForm)
  @Params(Ctx())
  @Post('/')
  submit(ctx: IRequestContext): FormProps | HandlerResult {
    const accepted = ctx.request.method === 'POST';
    return accepted
      ? ctx.response.redirect('/tasks', 303)
      : { values: { title: '' }, errors: { title: 'too short' } };
  }

  /** The async arm of the same union. */
  @Render(TaskForm)
  @Params(Ctx())
  @Post('/async')
  async submitAsync(ctx: IRequestContext): Promise<FormProps | HandlerResult> {
    await Promise.resolve();
    return ctx.response.redirect('/tasks', 303);
  }
}

@Controller('/bad')
export class WrongPropsController {
  // @ts-expect-error a props bag of the wrong shape is STILL rejected
  @Render(TaskForm)
  @Get('/')
  wrong(): { readonly totallyWrong: number } {
    return { totallyWrong: 1 };
  }
}

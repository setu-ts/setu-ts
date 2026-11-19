/**
 * Service refusals in React Router loaders, actions and resource routes.
 *
 * React Router answers any throw from a loader or action with 500, except a
 * thrown `Response`, which a resource route returns as is and a page renders
 * as a route error with its own status. These helpers turn a caller error
 * (a 4xx status hint, which every 4xx `HttpError` from `@setu-ts/exceptions`
 * carries) into one of those two shapes, and leave every other error alone so
 * a fault stays a fault.
 *
 * @module
 */
import { httpStatusHintOf } from '@setu-ts/common';
import type { HttpStatusHint } from '@setu-ts/common';

/** Reads the caller-error hint of a thrown value: a status from 400 to 499. */
function refusalOf(error: unknown): HttpStatusHint | undefined {
  const hint = httpStatusHintOf(error);
  return hint !== undefined && hint.status < 500 ? hint : undefined;
}

/**
 * Runs a service call for a loader or a resource route, keeping a refusal's
 * status.
 *
 * A refusal (an error carrying a 4xx status hint, as every 4xx `HttpError`
 * does) is thrown as an RFC 9457 Problem Details `Response`: the hint's status,
 * `content-type: application/problem+json`, `cache-control: private, no-store`,
 * and a body of `type`, `title`, `status`, `detail` and `instance` (the
 * request's path). A resource route returns it as is; a page's error boundary
 * receives it as a route error response with that status. Any other error,
 * a 5xx included, is rethrown untouched.
 *
 * @typeParam T - The service call's result
 * @param request - The loader's or action's request, for `instance`
 * @param work - The service call
 * @returns The service call's result
 * @throws {Response} The Problem Details response for a refusal
 *
 * @example
 * ```typescript
 * export async function loader({ request, context }: Route.LoaderArgs) {
 *   const orders = getService(context, ORDERS);
 *   return serviceCall(request, () => orders.list());
 * }
 * ```
 *
 * @since 0.14.0
 */
export async function serviceCall<T>(request: Request, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const hint = refusalOf(error);
    if (hint === undefined) throw error;
    throw new Response(
      JSON.stringify({
        type: hint.problem?.type ?? 'about:blank',
        title: hint.problem?.title ?? hint.title,
        status: hint.status,
        detail: hint.detail,
        instance: new URL(request.url).pathname,
      }),
      {
        status: hint.status,
        headers: {
          'content-type': 'application/problem+json',
          'cache-control': 'private, no-store',
        },
      },
    );
  }
}

/**
 * What {@linkcode pageAction} answers: the intent with the value, or the
 * refusal's detail and status for the page to show in place.
 *
 * @since 0.14.0
 */
export type PageActionResult<T> =
  | { readonly ok: true; readonly intent: string; readonly value: T }
  | {
      readonly ok: false;
      readonly intent: string;
      readonly error: string;
      readonly status: number;
    };

/**
 * Runs one intent of a page's `action`, returning a refusal to the form.
 *
 * A refusal (an error carrying a 4xx status hint, as every 4xx `HttpError`
 * does) becomes `{ ok: false, intent, error, status }` with the hint's
 * caller-safe detail, which the page renders through `useActionData`. Any
 * other error, a 5xx included, is rethrown to the route's error boundary.
 *
 * @typeParam T - The service call's result
 * @param intent - The intent the form posted, echoed in the result
 * @param work - The service call
 * @returns The value, or the refusal
 *
 * @example
 * ```typescript
 * export async function action({ request, context }: Route.ActionArgs) {
 *   const form = await request.formData();
 *   const orders = getService(context, ORDERS);
 *   const result = await pageAction('create', () => orders.create(form.get('name')));
 *   return result.ok ? redirect('/orders', 303) : result;
 * }
 * ```
 *
 * @since 0.14.0
 */
export async function pageAction<T>(
  intent: string,
  work: () => Promise<T>,
): Promise<PageActionResult<T>> {
  try {
    return { ok: true, intent, value: await work() };
  } catch (error) {
    const hint = refusalOf(error);
    if (hint === undefined) throw error;
    return { ok: false, intent, error: hint.detail, status: hint.status };
  }
}

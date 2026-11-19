# Pages that write through actions

A full-stack Setu-TS application is a React Router application served by the kernel. Its pages read
through their `loader` and write through their `action`, both calling the same request-bound module
service. Files, images and streams come from resource routes. None of this needs the application's
own `/api` routes: those are for callers outside the app, such as another service, a mobile client
or a script with a bearer token.

The `full-stack` template and the [full-stack example](../apps/full-stack/README.md) follow this
guide. `setu generate module <name> --page` writes a page in this shape, and `setu check` warns
(`setu.W007`) when a module under `app/` calls `fetch` on a path under `/api/`.

## Forms: an action and `pageAction`

A form posts to its page's action: as a document POST without JavaScript, and to the page's `.data`
URL when React Router has hydrated the page. Both reach the same `action`. Give the form the
session's CSRF token as a hidden `_csrf` field; the session plugin checks it before the action runs.
An index route's action is at `/<path>?index`.

```ts
import { redirect } from 'react-router';
import { getService, pageAction, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { ORDERS } from '~kernel/modules/orders/orders.token.ts';
import { getCsrfToken } from '~/server/session.server.ts';

/** The list, and the token the form posts back. */
export async function loader({ context }: { context: RouterLoadContext }) {
  const orders = await getService(context, ORDERS).list();
  return { orders, csrfToken: getCsrfToken(context) };
}

/** Creates an order, or returns why not to the form. */
export async function action({
  request,
  context,
}: {
  request: Request;
  context: RouterLoadContext;
}) {
  const form = await request.formData();
  const orders = getService(context, ORDERS);
  const input = orders.parse({ name: form.get('name') });
  if (typeof input === 'string') return { error: input };
  const result = await pageAction('create', () => orders.create(input));
  // 303: post/redirect/get, so a reload does not post again.
  return result.ok ? redirect('/orders', 303) : { error: result.error };
}
```

`pageAction(intent, work)` runs one service call. A refusal (an error carrying a 4xx status hint,
which every 4xx `HttpError` from `@setu-ts/exceptions` does, such as `conflict(…)` or `notFound(…)`)
comes back as `{ ok: false, intent, error, status }`, with the refusal's caller-safe detail. The
page renders it from `useActionData`. Any other error, a 5xx included, goes to the route's error
boundary. On success the result is `{ ok: true, intent, value }`.

The page's component renders `<Form method="post">`, the hidden `_csrf` input from `useLoaderData`,
and `actionData?.error`. `app/routes/_app/products._index.tsx` in the template is a complete page.

## Refusals in loaders and resource routes: `serviceCall`

React Router answers any error thrown from a loader or an action with 500, except a thrown
`Response`. `serviceCall(request, work)` turns a refusal into that `Response`: RFC 9457 Problem
Details with the refusal's status, `content-type: application/problem+json` and
`cache-control: private, no-store`, and a body of `type`, `title`, `status`, `detail` and `instance`
(the request's path). Any other error is rethrown, so a fault stays a fault.

```ts
import { getService, serviceCall, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { ORDERS } from '~kernel/modules/orders/orders.token.ts';

/** A missing or forbidden order keeps its 404 or 403 instead of answering 500. */
export async function loader({
  request,
  context,
}: {
  request: Request;
  context: RouterLoadContext;
}) {
  const orders = await serviceCall(request, () => getService(context, ORDERS).list());
  return { orders };
}
```

In a page, the route's `ErrorBoundary` receives the thrown `Response` as a route error response with
its status. React Router parses only an `application/json` body, so `error.data` is the Problem
Details JSON as text:

```ts
import { isRouteErrorResponse } from 'react-router';

/** The caller-safe detail of a refusal, for an error boundary to show. */
export function refusalDetail(error: unknown): string | undefined {
  if (!isRouteErrorResponse(error) || error.status >= 500) return undefined;
  const body: unknown = typeof error.data === 'string' ? JSON.parse(error.data) : error.data;
  return (body as { readonly detail?: string }).detail;
}
```

A refusal thrown as a `Response` is not a server fault, so React Router does not pass it to the
server entry's `handleError`, and nothing logs it as one.

`serviceCall` carries the refusal's status and detail, not its headers. A refusal that needs one,
such as a quota's `Retry-After`, comes from a request-bound service that writes the kernel's own
error response and hands it back as a `Response` (see [Streams](#streams-a-resource-route-action)).

## Uploads

A file arrives in the action as a `File` in `request.formData()`. Bound it before the action runs:
register `createUploadMiddleware` from `@setu-ts/storage-plugin` as a page policy on the route's
action, which refuses an oversized file with 413 and a wrong type with 400.

```ts
import { createUploadMiddleware } from '@setu-ts/storage-plugin';
import type { PagePolicy } from '@setu-ts/react-router-plugin';

/** Ten MiB of PDF, one file, before the action reads the form. */
export const attachmentPolicy: PagePolicy = {
  on: 'action',
  middleware: [
    createUploadMiddleware({
      fieldname: 'file',
      maxSize: 10 * 1024 * 1024,
      maxFiles: 1,
      allowedMimeTypes: ['application/pdf'],
    }),
  ],
};
```

Register it in `setu.config.ts` under the starter's `reactRouter.pagePolicies`, keyed by the page's
route id written out (for `app/routes/_app/orders.$id.tsx`, `'routes/_app/orders.$id'`). The starter
refuses any request body over 1 MiB by default: raise `runtime.maxBodyBytes` in the same options to
admit the largest upload, since the policy bounds each route on its own. The action then reads the
file:

```ts
import { getService, pageAction, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { ORDERS } from '~kernel/modules/orders/orders.token.ts';

/** Attaches the uploaded PDF to the order. */
export async function action({
  request,
  context,
  params,
}: {
  request: Request;
  context: RouterLoadContext;
  params: { readonly id?: string };
}) {
  const file = (await request.formData()).get('file');
  if (!(file instanceof File)) return { error: 'Choose a PDF to attach.' };
  const orders = getService(context, ORDERS);
  return pageAction('attach', () => orders.attach(params.id ?? '', file));
}
```

## Downloads and images: resource routes

A route module with no default component is a resource route: React Router returns its loader's or
action's `Response` as is. Serve a file, an image or a PDF from one, behind the same route
middleware as the page that links to it, and link to it with a plain `<a href>` (or React Router's
`reloadDocument`), so the browser downloads it instead of navigating client-side.

```ts
import { getService, serviceCall, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { ORDERS } from '~kernel/modules/orders/orders.token.ts';

/** `app/routes/_app/orders.$id.invoice.ts`: the order's invoice PDF. */
export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: RouterLoadContext;
  params: { readonly id?: string };
}) {
  const orders = getService(context, ORDERS);
  const bytes = await serviceCall(request, () => orders.invoice(params.id ?? ''));
  return new Response(bytes.slice(), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="invoice.pdf"',
      'cache-control': 'private, no-store',
    },
  });
}
```

The full-stack example's `app/routes/_app/products.export.tsx` downloads its catalogue as CSV this
way.

## Streams: a resource-route action

A stream, such as an AI SDK UI message stream for `useChat`, is a resource route whose action
returns the stream's `Response`. The work that needs the kernel request context (a quota, a budget,
`ctx.signal`) lives in a request-bound service, which the action reaches with `getService`:

```ts
import { getService, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { CHAT } from '~kernel/modules/chat/chat.token.ts';

/** `app/routes/_app/chat.ts`: posted by `useChat`, answered with the UI message stream. */
export async function action({
  request,
  context,
}: {
  request: Request;
  context: RouterLoadContext;
}) {
  const body: unknown = await request.json().catch(() => ({}));
  return getService(context, CHAT).answer(body);
}
```

The service builds the stream with `createUIMessageStreamResponse` (see
[AI calls](./ai.md#from-a-full-stack-page)). For a refusal that must carry headers, it writes the
refusal through `respondWithError` (or the auth plugin's `respondQuotaExceeded`), then returns
`ctx.response.snapshot()`'s status, headers and body as a `Response`, so the page gets the same 429
and `Retry-After` an API caller would. The form-CSRF check reads the `x-csrf-token` header, so give
`useChat`'s transport the page's token in its headers.

## Sign-out

Sign-out is a POST, so a link or a prefetch cannot sign anyone out. The template's
`app/routes/_app/logout.tsx` is a guarded page whose form posts to its own action:

```ts
import { redirect } from 'react-router';
import type { RouterLoadContext } from '@setu-ts/react-router-plugin';
import { getSession } from '~/server/session.server.ts';

/** Ends the session the way the template's sign-in starts it. */
export function action({ context }: { context: RouterLoadContext }) {
  const session = getSession(context);
  session.clear();
  session.regenerate();
  return redirect('/login', 303);
}
```

`clear()` drops the signed-in user and `regenerate()` gives the browser a new session id and CSRF
token. An application signing in through the auth plugin calls its session service's `signOut(ctx)`
from a request-bound service instead. The header links to the sign-out page rather than rendering
the form itself: a loader on the layout would give it the token, but React Router renders a child
route's middleware refusal at the highest route with a loader, so every child's refusal would move
up to the layout's error boundary.

## Testing pages

`setu generate module <name> --page` writes `test/support/pages.ts` beside the session helpers. Its
`postForm(baseUrl, path, fields, session)` posts a form as a browser without JavaScript does, and
`pageData(baseUrl, path, routeId, session)` reads one route's loader data from
`<path>.data?_routes=<routeId>`, decoded with React Router's own decoder. A test drives the page the
way the browser does, with no JSON API kept for it. The route id of a page at
`app/routes/_app/orders._index.tsx` is `routes/_app/orders._index`.

The sign-in step those tests use lives in `test/support/sign-in.ts`, which belongs to the
application: `setu` writes it once and never overwrites it. When the application replaces the
template's placeholder sign-in, change `signIn` there to sign in the way the application does.

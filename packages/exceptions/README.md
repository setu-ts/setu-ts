# @setu-ts/exceptions

Exception hierarchy, factory functions, error formatters, and the global error-handler middleware.

This is a **plain package, not a plugin** — it depends on `@setu-ts/common` only and registers no
capability. You wire the middleware into the application pipeline yourself.

## Installation

```typescript
import { errorHandler, notFound } from '@setu-ts/exceptions';
```

## Usage

```typescript
import { badRequest, errorHandler, HttpError, notFound } from '@setu-ts/exceptions';

app.middleware.add(errorHandler({ format: 'rfc9457' }), {
  priority: 0,
  name: 'error-handler',
});

app.router.get('/users/:id', async (ctx) => {
  const user = await users.find(ctx.params.id);
  if (!user) throw notFound('User not found');
  return ctx.response.json(user);
});
```

## Options

`errorHandler(options?)` takes:

| Option               | Type                                                                                                            | Default     | Description                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `format`             | `ErrorFormat \| ErrorHandlerFormatter`                                                                          | `'default'` | Body shape, or a formatter function.                                                                                     |
| `includeStackTrace`  | `boolean`                                                                                                       | `false`     | Add the stack to the body. Development only.                                                                             |
| `maskInternalErrors` | `boolean`                                                                                                       | `true`      | Replace unhandled non-`HttpError` 5xx diagnostics with their status title before serving the response.                   |
| `logErrors`          | `boolean`                                                                                                       | `true`      | Report handled errors to the resolved `ILogger`.                                                                         |
| `respond`            | `(error: HttpError, ctx: IRequestContext) => HandlerResult \| undefined \| Promise<HandlerResult \| undefined>` | —           | Write an application-owned caught-error response; return or resolve `undefined` to use the configured formatter instead. |

`format` accepts `'default'`, `'rfc9457'`, the deprecated `'rfc7807'`, or a function. Passing a
formatter directly is equivalent to naming it — both paths select the same
`application/problem+json` content type for Problem Details bodies.

`respond` is called after error normalization, masking, and status resolution. It can return or
resolve an HTML (or another application-owned) result through `ctx.response`; the callback owns that
result's status, headers, and body. The log retains the unmasked diagnostic and records the status
that result serves. It applies only to errors caught by `errorHandler`, not responder-based
terminals such as an unmatched-path `404`.

The natural spelling of the hook omits the one statement that matters and serves `200` for every
branded error: `renderView(ctx, Component, props)` takes no status, and nothing else sets it. The
callback owns the status, so the example carries that line on its own:

```tsx
import { errorHandler, statusTitle } from '@setu-ts/exceptions';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';

interface ErrorPageProps {
  readonly status: number;
  readonly title: string;
}

const ErrorPage = (props: ErrorPageProps) => (
  <main>
    <h1>{props.status}</h1>
    <p>{props.title}</p>
  </main>
);

function wantsHtml(ctx: IRequestContext): boolean {
  // Deliberately simple — the point here is that the callback owns the status,
  // not content negotiation. This does NOT honour `q` values, so a client
  // sending `text/html;q=0` (a refusal) still gets HTML; parse the media
  // ranges if your callers send them.
  return (ctx.request.headers.get('accept') ?? '').includes('text/html');
}

app.middleware.add(
  errorHandler({
    format: 'rfc9457',
    async respond(error, ctx): Promise<HandlerResult | undefined> {
      if (!wantsHtml(ctx)) return undefined; // API clients keep Problem Details
      // The callback owns the result's status, and renderView takes none —
      // without this line every branded error answers 200.
      ctx.response.status(error.statusCode);
      return await renderView(ctx, ErrorPage, {
        status: error.statusCode,
        title: statusTitle(error.statusCode),
      });
    },
  }),
  { priority: 0, name: 'error-handler' },
);
```

What the hook does NOT cover is stated by the rule in
[docs/mvc.md](https://github.com/setu-ts/setu-ts/blob/main/docs/mvc.md#error-pages): every responder
terminal — an unmatched-path `404`, a guard's `401`, the rate limiter's `429` — is emitted outside
`errorHandler`, so each keeps its formatter's JSON no matter what this callback renders.

## What it exports

- **`HttpError`** — the error type, carrying a status, a title, and optional validation details.
- **Factories** — `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`,
  `tooManyRequests`, `internalServerError`, `notImplemented`, `serviceUnavailable`,
  `validationError`, plus `statusTitle` / `STATUS_TITLES`.
- **Formatters** — `defaultFormatter` and `rfc9457Formatter` ([RFC 9457][rfc9457] Problem Details),
  plus a deprecated `rfc7807Formatter`, selected by `selectFormatter`. A Problem Details body
  carries `detail`, never `message`.
- **Middleware** — `errorHandler(options)`.

## Problem Details and `about:blank`

The `'rfc9457'` format emits `type: "about:blank"` for any error whose only semantics are its status
code — which is every factory in this package except `validationError()`. [RFC 9457][rfc9457] §4.2
registers `about:blank` for exactly that case, because a URI minted from the status code identifies
nothing the `status` member does not already carry. Read `status` to distinguish errors.

`validationError()` is the exception: it defines an `errors` extension member, so it is a distinct
problem type identified by `https://setu-ts.dev/errors/validation` — the same URI
`@setu-ts/validation-plugin` uses.

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "User 42 does not exist",
  "instance": "/users/42"
}
```

> **`'rfc7807'` is deprecated.** RFC 7807 was obsoleted by RFC 9457 in July 2023. The `'rfc7807'`
> alias and `rfc7807Formatter` still emit the status-derived `type`
> (`https://setu-ts.dev/errors/404`) they always did — a deprecated symbol must not silently change
> behavior — so upgrading is a deliberate one-word edit. Removal is scheduled for v1.0.0.

## Exports

| Export | Kind |
| --- | --- |
| `badRequest` | function |
| `conflict` | function |
| `defaultFormatter` | function |
| `errorHandler` | function |
| `forbidden` | function |
| `internalServerError` | function |
| `notFound` | function |
| `notImplemented` | function |
| `rfc7807Formatter` | function |
| `rfc9457Formatter` | function |
| `selectFormatter` | function |
| `serviceUnavailable` | function |
| `statusTitle` | function |
| `tooManyRequests` | function |
| `unauthorized` | function |
| `validationError` | function |
| `HttpError` | class |
| `ERROR_TYPE_BASE` | const |
| `STATUS_TITLES` | const |
| `DefaultErrorBody` | interface |
| `ErrorHandlerOptions` | interface |
| `HttpErrorInit` | interface |
| `ProblemDetails` | interface |
| `ValidationError` | interface |
| `ErrorFormat` | type |
| `ErrorHandlerFormatter` | type |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export, its signature, and the exact response shapes are documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsexceptions).

[rfc9457]: https://www.rfc-editor.org/rfc/rfc9457.html

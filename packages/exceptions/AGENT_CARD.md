# @setu-ts/exceptions — HTTP errors and error responses

**Add it:** REST scaffolds install this package; there is no `setu add` entry or capability. In
`setu.config.ts`, register `errorHandler` on the global middleware pipeline.

## Format thrown errors consistently

```ts
import { errorHandler } from "@setu-ts/exceptions";

app.middleware.add(errorHandler({ format: "rfc9457" }), {
  priority: 0,
  name: "error-handler",
});
```

## Refuse a request with an HTTP error

```ts
import type { IRouterApi } from "@setu-ts/common";
import { notFound } from "@setu-ts/exceptions";

export function registerUserRoutes(router: IRouterApi): void {
  router.get("/users/:id", {
    handler: (ctx) => {
      throw notFound(`User ${ctx.params.id} not found`);
    },
  });
}
```

## Behaviour the types do not show

- Priority `0` makes the handler wrap downstream middleware and routes; it catches their throws.
- `format` defaults to `"default"`; `"rfc9457"` sends `application/problem+json`.
- `maskInternalErrors` defaults to `true`: unexpected 5xx messages become the status title;
  deliberately thrown `HttpError` messages are preserved.
- `includeStackTrace` defaults to `false`; masked errors never expose a stack even when enabled.
- `logErrors` defaults to `true`: warn below 500, error otherwise. Without a logger, only 5xx
  reaches the runtime error sink.
- `respond` sees the normalized, masked error and resolved status. A returned response owns its
  status, headers and body; `undefined` falls through to the configured formatter.

## Other options

- `badRequest`, `unauthorized`, `forbidden`, `conflict`, `tooManyRequests` and `serviceUnavailable`
  create other HTTP refusals.
- `validationError` stores field failures in `details.errors`; `internalServerError` accepts a
  cause.
- `format` also accepts a formatter function or the deprecated `"rfc7807"` arm.

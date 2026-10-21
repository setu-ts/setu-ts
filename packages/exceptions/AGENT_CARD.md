# @setu-ts/exceptions — HTTP errors and the error-handler middleware

Every scaffold depends on this; `setu add` has no entry and it provides no capability. Add
`errorHandler` to the global pipeline yourself, before routes run.

```ts
import type { IKernelApplication } from '@setu-ts/kernel';
import { errorHandler, notFound } from '@setu-ts/exceptions';

export function registerErrorHandling(application: IKernelApplication): void {
  application.middleware.add(errorHandler({ format: 'rfc9457' }), {
    priority: 0,
    name: 'error-handler',
  });
  application.router.get('/users/:id', () => {
    throw notFound('User not found');
  });
}
```

- `ErrorHandlerOptions.format` defaults to `'default'`; `'rfc9457'` serves
  `application/problem+json`. `'rfc7807'` is deprecated; a formatter function is accepted too.
- `includeStackTrace` defaults to false and belongs in development only. `maskInternalErrors`
  defaults to true and replaces an unhandled non-`HttpError` 5xx message with the status title; a
  deliberate `HttpError` is never masked.
- `logErrors` defaults to true: warn below 500, error otherwise. Without a logger, handled 5xx goes
  to the runtime's `reportError` sink and handled 4xx stays silent.
- `respond(error, context)` runs after normalization, masking and status resolution. It owns the
  returned response's status, headers and body; return undefined to use the formatter.
- Factories all return `HttpError`: `badRequest`, `unauthorized`, `forbidden`, `notFound`,
  `conflict`, `validationError`, `tooManyRequests`, `internalServerError`, `notImplemented` and
  `serviceUnavailable`. `validationError(errors)` stores failures in `details.errors`;
  `internalServerError(message, cause?)` keeps the cause chain.
- `HttpError` carries `statusCode`, `message` and optional `details`; construct one directly with
  `HttpError.from(...)` or throw a factory result. `statusTitle(code)` gives the canonical title.

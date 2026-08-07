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

app.middleware.add(errorHandler({ format: 'rfc7807' }), {
  priority: 0,
  name: 'error-handler',
});

app.router.get('/users/:id', async (ctx) => {
  const user = await users.find(ctx.request.params.id);
  if (!user) throw notFound('User not found');
  return ctx.response.json(user);
});
```

## What it exports

- **`HttpError`** — the error type, carrying a status, a title, and optional validation details.
- **Factories** — `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`,
  `tooManyRequests`, `internalServerError`, `notImplemented`, `serviceUnavailable`,
  `validationError`, plus `statusTitle` / `STATUS_TITLES`.
- **Formatters** — `defaultFormatter` and `rfc7807Formatter` (RFC 7807 Problem Details), selected by
  `selectFormatter`. A Problem Details body carries `detail`, never `message`.
- **Middleware** — `errorHandler(options)`.

## Full API

Every export, its signature, and the exact response shapes are documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).

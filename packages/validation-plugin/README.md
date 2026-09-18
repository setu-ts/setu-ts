# @setu-ts/validation-plugin

Zod-compatible request validation. Registers a validation service under `CAPABILITIES.VALIDATION`
(`'validation'`) and ships middleware helpers for body, query, params, headers, and cookies.

Schemas are duck-typed through `safeParse`, so any Zod-compatible validator works. Both **zod v3
(`>=3.24.0 <4`) and zod v4 (`>=4.4.0 <5`)** are supported (each provides public `safeParse`); there
is no version pin on the plugin — an application uses whichever major it installs, and
`@setu-ts/openapi-plugin` recognizes either when documenting routes. `deno task check:compat`
exercises each declared major independently.

## Installation

```typescript
import { validatedStateKey } from '@setu-ts/common';
import { validateBody, ValidationPlugin } from '@setu-ts/validation-plugin';
```

## Usage

```typescript
import { z } from 'zod';
import { validatedStateKey } from '@setu-ts/common';
import { validateBody, ValidationPlugin } from '@setu-ts/validation-plugin';

const CreateUser = z.object({ email: z.string().email(), age: z.number().int() });

app.register(ValidationPlugin({ errorFormat: 'rfc9457' }));

app.router.post('/users', {
  middleware: [validateBody(CreateUser)],
  handler: async (ctx) => {
    const body = ctx.state.get(validatedStateKey('body'));
    return ctx.response.json(body);
  },
});
```

## Options

| Option                 | Type                                               | Default     | Description                                                     |
| ---------------------- | -------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| `errorFormat`          | `'default' \| 'rfc9457' \| 'nestjs'` or a function | `'default'` | Shape of the error response.                                    |
| `whitelist`            | `boolean`                                          | `false`     | Strip properties the schema does not declare (`.strip()`).      |
| `forbidNonWhitelisted` | `boolean`                                          | `false`     | Reject unknown properties (`.strict()`); wins over `whitelist`. |

Whitelisting and strictness are applied **once per middleware at registration time**, not per
request.

## Error formats

`rfc9457Formatter` emits [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) Problem Details
(carrying `detail`, never `message`); `nestjsFormatter` emits the NestJS-style shape. The middleware
helpers and the service both honour the plugin's configured `errorFormat` — there is one
implementation behind both entry points.

A validation failure carries an `errors` extension member, so it is a distinct problem type with a
concrete `type` URI rather than the `about:blank` that `@setu-ts/exceptions` emits for status-only
problems. Both packages spell that URI `https://setu-ts.dev/errors/validation`.

> **`'rfc7807'` is deprecated.** RFC 7807 was obsoleted by RFC 9457 in July 2023. Here the alias is
> bound to the **same formatter**, so the emitted body is byte-identical and migrating changes
> nothing on the wire. Removal is scheduled for v1.0.0.

## The schema also documents the route

Every middleware this package produces — the five `validateXxx` helpers and
`IValidationService.middleware(schema, target)` alike — is branded with `RouteValidationMetadata`
from `@setu-ts/common`, carrying its target and the schema itself.

`@setu-ts/openapi-plugin` reads that brand, so a route carrying `validateBody(schema)` is documented
with a matching `requestBody` and needs no second declaration in `schema.body`. Neither package
imports the other; the `Symbol.for`-keyed brand in `common` is the whole channel.

The brand is a description, not a mechanism: it is symbol-keyed and non-enumerable, the middleware's
identity and behaviour are unchanged, and removing it would change nothing this package does.

## Exports

| Export | Kind |
| --- | --- |
| `createSanitizer` | function |
| `createValidationMiddleware` | function |
| `defaultFormatter` | function |
| `nestjsFormatter` | function |
| `resolveFormatter` | function |
| `rfc9457Formatter` | function |
| `sanitize` | function |
| `validateBody` | function |
| `validateCookies` | function |
| `validateHeaders` | function |
| `validateParams` | function |
| `validateQuery` | function |
| `ValidationPlugin` | function |
| `ValidationService` | class |
| `rfc7807Formatter` | const |
| `FormattedError` | interface |
| `FormatValidationErrors` | interface |
| `SanitizationRules` | interface |
| `ValidationPluginOptions` | interface |
| `ErrorFormat` | type |
| `ValidationErrorFormatter` | type |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#validationplugin-setu-tsvalidation-plugin).

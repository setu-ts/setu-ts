# @setu-ts/validation-plugin

Zod-compatible request validation. Registers a validation service under `CAPABILITIES.VALIDATION`
(`'validation'`) and ships middleware helpers for body, query, params, headers, and cookies.

Schemas are duck-typed through the public `safeParse` method. The supported Zod range is
**`>=4.6.6 <5`**, and validation is tested with Zod 4 only. The plugin does not import Zod;
applications install their own supported version. `pnpm run check:compat` exercises validation and
OpenAPI generation with Zod 4.

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

## Reading the validated value

The five `validateXxx` helpers and `createValidationMiddleware` return
`ValidatorMiddleware<ValidatedOutput<S>>` — a `MiddlewareFunction` (so every existing call site
type-checks unchanged) with one added member, `value(ctx)`:

```typescript
import { z } from 'zod';
import { validateBody, ValidationPlugin } from '@setu-ts/validation-plugin';

const CreateUser = z.object({ email: z.string().email(), age: z.number().int() });
const createBody = validateBody(CreateUser);

app.register(ValidationPlugin());

app.router.post('/users', {
  middleware: [createBody],
  handler: (ctx) => ctx.response.json(createBody.value(ctx)), // typed ValidatedOutput<typeof CreateUser>
});
```

`ValidatedOutput<S>` is the schema's parsed output type — coercions and defaults included — and it
is inferred from the schema you pass, so the type follows the schema instead of being restated in
the handler. `value(ctx)` returns the stored value only when that validator ran on the request; it
throws a `TypeError` naming the target otherwise — when the validator is not in the route's chain,
or a later validator for the same target overwrote it — a programming error that `errorHandler`
masks to a 500. The old read still works and is unchanged:
`ctx.state.get(validatedStateKey('body'))` keeps carrying the parsed value, and the
`@ValidateBody`/`@ValidateQuery`/`@ValidateParams` resolvers read through it.

## Form bodies

`validateBody(schema, { forms: true })` and `@ValidateBody(schema, { forms: true })` also validate
`application/x-www-form-urlencoded` and `multipart/form-data` bodies with the same schema they
validate a JSON body with. Off by default: a cross-site HTML `<form>` reaches a route that accepts
forms with no CORS preflight, so pair an opted-in route with form CSRF protection
(`csrfFormMiddleware` from `@setu-ts/session-plugin`). Without the option a form body answers `415`
"Unsupported Media Type". With the option, a server-rendered `<form>` post validates against the
schema a JSON client passes, and reads back through `value(ctx)`.

The first-party validation service accepts `application/json` and any `application/*+json` media
type (case-insensitive, parameters ignored). Unsupported types, including `text/plain` and an absent
`Content-Type`, answer `415` before any body read, in the application's configured error format.
Send `Content-Type: application/json` when posting JSON; this also applies to an empty request on a
body-validated route. Routes that call `ctx.request.json()` themselves are unchanged, and
replacement `IValidationService` implementations own their media-type handling. Cookie-authenticated
routes still need `csrfMiddleware` or `csrfFormMiddleware`. The 415 takes the error responder's
format, while a `400` validation failure takes `ValidationPlugin({ errorFormat })`, so set both to
the same format; the CLI templates set both to `'rfc9457'`.

The form is converted to a record before validation:

- a field sent once is a single value; a repeated field becomes an array of its values in wire
  order;
- a name ending `[]` is always an array, kept under the name as written;
- values are strings or the framework's `FormFile` — NOT a web `File`, so `z.instanceof(File)`
  refuses a file part and a schema checks the `FormFile` shape instead;
- numbers and booleans arrive as strings — use `z.coerce` in the schema for them.

Stated limits: the generated OpenAPI document still describes a validated body as
`application/json`; the session plugin's `_csrf` field reaches the schema, where a Zod object strips
the unknown key by default and `forbidNonWhitelisted` (or the schema's own `.strict()`) refuses it;
and an over-limit body answers `413` when `RuntimePlugin({ maxBodyBytes })` is set — previously such
a body answered `400` on a validated route.

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

| Export                       | Kind      |
| ---------------------------- | --------- |
| `createSanitizer`            | function  |
| `createValidationMiddleware` | function  |
| `defaultFormatter`           | function  |
| `nestjsFormatter`            | function  |
| `resolveFormatter`           | function  |
| `rfc9457Formatter`           | function  |
| `sanitize`                   | function  |
| `validateBody`               | function  |
| `validateCookies`            | function  |
| `validateHeaders`            | function  |
| `validateParams`             | function  |
| `validateQuery`              | function  |
| `ValidationPlugin`           | function  |
| `ValidationService`          | class     |
| `rfc7807Formatter`           | const     |
| `FormattedError`             | interface |
| `FormatValidationErrors`     | interface |
| `SanitizationRules`          | interface |
| `ValidationPluginOptions`    | interface |
| `ErrorFormat`                | type      |
| `ValidatedOutput`            | type      |
| `ValidationErrorFormatter`   | type      |
| `ValidatorMiddleware`        | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#validationplugin-setu-tsvalidation-plugin).

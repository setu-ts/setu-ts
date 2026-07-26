# @hono-enterprise/validation-plugin

Zod-compatible request validation. Registers a validation service under `CAPABILITIES.VALIDATION`
(`'validation'`) and ships middleware helpers for body, query, params, headers, and cookies.

Schemas are duck-typed through `safeParse`, so any Zod-compatible validator works.

## Installation

```typescript
import { validateBody, ValidationPlugin } from '@hono-enterprise/validation-plugin';
```

## Usage

```typescript
import { z } from 'zod';
import { validateBody, ValidationPlugin } from '@hono-enterprise/validation-plugin';

const CreateUser = z.object({ email: z.string().email(), age: z.number().int() });

app.register(ValidationPlugin({ errorFormat: 'rfc7807' }));

app.router.post('/users', {
  middleware: [validateBody(CreateUser)],
  handler: async (ctx) => {
    const body = ctx.state.get('validatedBody');
    return ctx.response.json(body);
  },
});
```

## Options

| Option                 | Type                                               | Default     | Description                                                     |
| ---------------------- | -------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| `errorFormat`          | `'default' \| 'rfc7807' \| 'nestjs'` or a function | `'default'` | Shape of the error response.                                    |
| `whitelist`            | `boolean`                                          | `false`     | Strip properties the schema does not declare (`.strip()`).      |
| `forbidNonWhitelisted` | `boolean`                                          | `false`     | Reject unknown properties (`.strict()`); wins over `whitelist`. |

Whitelisting and strictness are applied **once per middleware at registration time**, not per
request.

## Error formats

`rfc7807Formatter` emits RFC 7807 Problem Details (carrying `detail`, never `message`);
`nestjsFormatter` emits the NestJS-style shape. The middleware helpers and the service both honour
the plugin's configured `errorFormat` — there is one implementation behind both entry points.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).

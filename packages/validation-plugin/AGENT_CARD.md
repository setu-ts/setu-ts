# @setu-ts/validation-plugin — Zod-compatible request validation

`setu add validation` adds the dependency and its zod peer; REST scaffolds register
`ValidationPlugin({ errorFormat: 'rfc9457' })`. It provides `CAPABILITIES.VALIDATION`.

```ts
import { z } from 'zod';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const CreateUser = z.object({ name: z.string().min(1) });

export function createValidatedApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), ValidationPlugin({ errorFormat: 'rfc9457' })],
  });
  const body = validateBody(CreateUser);
  app.router.post('/users', {
    middleware: [body],
    handler: (ctx) => ctx.response.status(201).json(body.value(ctx)),
  });
  return app;
}
```

- `ValidationPluginOptions.errorFormat` defaults to `'default'`; `'rfc9457'` serves
  `application/problem+json`, `'nestjs'` matches that framework, and a formatter function is
  accepted.
- `whitelist` strips properties the schema does not declare by calling its `.strip()` once at
  registration. `forbidNonWhitelisted` rejects them via `.strict()` and wins when both are set. A
  schema without those methods is used unchanged.
- Helpers `validateBody`, `validateQuery`, `validateParams`, `validateHeaders` and `validateCookies`
  return a `ValidatorMiddleware`; read its parsed output with `body.value(ctx)`. The value is
  tracked per middleware instance, so a later validator on the same target cannot silently change
  what an earlier reader returns. `ValidatedOutput<typeof schema>` types the result.
- Schemas are duck-typed through `safeParse`, so any Zod-compatible object works; TypeScript users
  get output inference from the schema.
- Invalid input answers 400 with the configured format; a body that is not JSON or a supported form
  answers 415. Register `errorHandler` from `@setu-ts/exceptions` for the same Problem Details shape
  on thrown errors.

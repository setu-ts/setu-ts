# @setu-ts/validation-plugin — validate and read parsed requests

**Add it:** `setu add validation` adds this package and `zod`; register `ValidationPlugin()` in
`setu.config.ts` (the REST scaffold uses `errorFormat: "rfc9457"`). It provides
`CAPABILITIES.VALIDATION` (`IValidationService`).

## Validate a JSON body

```ts
import { z } from "zod";
import type { IRouterApi } from "@setu-ts/common";
import { validateBody } from "@setu-ts/validation-plugin";

export function registerUserRoutes(router: IRouterApi): void {
  const body = validateBody(z.object({ name: z.string().min(1) }));
  router.post("/users", {
    middleware: [body],
    handler: (ctx) => ctx.response.status(201).json(body.value(ctx)),
  });
}
```

## Coerce query strings into typed values

```ts
import { z } from "zod";
import type { IRouterApi } from "@setu-ts/common";
import { validateQuery } from "@setu-ts/validation-plugin";

export function registerSearchRoutes(router: IRouterApi): void {
  const query = validateQuery(z.object({ page: z.coerce.number().int().min(1).default(1) }));
  router.get("/search", {
    middleware: [query],
    handler: (ctx) => ctx.response.json(query.value(ctx)),
  });
}
```

## Behaviour the types do not show

- Helpers resolve the configured validation service from `ctx.services`, so they use its error
  format and unknown-property policy.
- `body.value(ctx)` returns parsed output, including transformations and defaults. It throws
  TypeError if that validator never ran successfully or a later validator overwrote its target.
- Invalid input answers `400` before the handler runs. Body validation requires a JSON media type by
  default; unsupported or missing content types answer `415`, malformed JSON answers `400`.
- `errorFormat` defaults to `"default"`; `"rfc9457"` serves `application/problem+json`.
- `whitelist` uses the schema strip method; `forbidNonWhitelisted` uses its strict method and takes
  precedence. Schemas without the respective methods are unchanged.

## Other options

- `validateBody(schema, { forms: true })` also accepts URL-encoded and multipart forms.
- `validateParams`, `validateHeaders` and `validateCookies` validate the other request targets.
- `errorFormat` also accepts `"nestjs"` or a custom formatter; `ValidatedOutput` names inferred
  output.

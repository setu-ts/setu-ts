# @setu-ts/decorator-plugin

Optional NestJS-style decorators as syntactic sugar over the kernel's programmatic API.

Decorators capture metadata in a plain `MetadataStore` — **no `reflect-metadata`, no reflection
polyfill**. `DecoratorPlugin` reads that store at registration time and registers routes, services,
and middleware with the kernel. Decorators are inert unless the plugin is registered.

The store itself is registered under `CAPABILITIES.METADATA_STORE` (`'metadata-store'`).

## Schema compatibility

`@ValidateBody`, `@ValidateQuery`, and `@ValidateParams` preserve application-created schemas and
hand them to the validation/OpenAPI boundaries; this package does not inspect Zod internals. The
supported Zod ranges are therefore the shared validation contract: `>=3.24.0 <4` and `>=4.4.0 <5`.
`deno task check:compat` exercises both majors through the validation and OpenAPI owners.

## Installation

```typescript
import { Controller, DecoratorPlugin, Get } from '@setu-ts/decorator-plugin';
```

## Usage

```typescript
import {
  Body,
  Controller,
  DecoratorPlugin,
  Get,
  Param,
  Params,
  Post,
} from '@setu-ts/decorator-plugin';

@Controller('/users')
class UsersController {
  @Get('/:id')
  @Params(Param('id'))
  findOne(id: string) {
    return { id };
  }

  @Post('/')
  @Params(Body())
  create(body: unknown) {
    return body;
  }
}

app.register(DecoratorPlugin({ controllers: [UsersController] }));
```

## Validation is enforced

`@ValidateBody(schema)` (and `@ValidateQuery` / `@ValidateParams`) do not merely describe a route
for OpenAPI. When a `CAPABILITIES.VALIDATION` provider is registered — `ValidationPlugin`, or any
replacement — and `enforceSchemas` is not `false`, the capability's middleware is appended LAST in
the route's chain (innermost, after guards), so an invalid request is answered `400` before the
handler runs while guard `401`/`403` precedence is preserved. `@Body()`, `@Query()` and `@Param()`
then hand the handler the VALIDATED value — transforms, defaults and coercions included — falling
back to the raw source when no validated value exists. Without a validation provider the schemas
stay description-only and the plugin logs one warning per affected route naming `ValidationPlugin`.

```typescript
import {
  Body,
  Controller,
  DecoratorPlugin,
  Params,
  Post,
  ValidateBody,
} from '@setu-ts/decorator-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { z } from 'zod';

const CreateUser = z.object({ email: z.string().email(), age: z.number().int().default(18) });

@Controller('/users')
class UsersController {
  @Post('/')
  @ValidateBody(CreateUser)
  @Params(Body())
  create(body: { email: string; age: number }) {
    return body; // the TRANSFORMED value: `age` defaulted to 18 by the schema
  }
}

app.register(ValidationPlugin());
app.register(DecoratorPlugin({ controllers: [UsersController] }));
```

## What it exports

- **Routing** — `@Controller`, `@Version`,
  `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`/`@Head`/`@Options`
- **Parameters** — `@Body`, `@Query`, `@Param`, `@Header`, `@Cookie`, `@Ctx`
- **Injection** — `@Injectable`, `@Inject`, `@Optional`
- **Security** — `@Roles`, `@Permissions`, `@Public`, `@CurrentUser`
- **Pipeline** — `@UseGuards`, `@UseInterceptors`, `@UseFilters`
- **Validation** — `@ValidateBody`, `@ValidateQuery`, `@ValidateParams`
- **OpenAPI** — `@ApiTags`, `@ApiOperation`, `@ApiResponse`
- **Extension** — `createDecorator`, `createParameterDecorator`, `registerParameterResolver`
- **Discovery** — `discoverControllers`

## Options

| Option            | Type            | Default | Description                                                                                                                                                                       |
| ----------------- | --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controllers`     | `Constructor[]` | `[]`    | Controller classes to register explicitly.                                                                                                                                        |
| `services`        | `Constructor[]` | `[]`    | Service classes to register explicitly.                                                                                                                                           |
| `autoDiscover`    | `boolean`       | `false` | Scan `controllersPath` for decorated classes.                                                                                                                                     |
| `controllersPath` | `string`        | —       | Glob path used when `autoDiscover` is `true`.                                                                                                                                     |
| `enforceSchemas`  | `boolean`       | `true`  | Append the validation capability's middleware for each present `@ValidateXxx` target. `false` keeps schemas description-only (OpenAPI) and silences the missing-provider warning. |

Discovery failures are logged as warnings and never crash the application.

## Exports

| Export | Kind |
| --- | --- |
| `ApiOperation` | function |
| `ApiResponse` | function |
| `ApiTags` | function |
| `Body` | function |
| `clearParameterResolvers` | function |
| `Controller` | function |
| `Cookie` | function |
| `createDecorator` | function |
| `Ctx` | function |
| `CurrentUser` | function |
| `Custom` | function |
| `DecoratorPlugin` | function |
| `discoverControllers` | function |
| `getParameterResolver` | function |
| `Header` | function |
| `Inject` | function |
| `Injectable` | function |
| `Optional` | function |
| `Param` | function |
| `Params` | function |
| `parseCookies` | function |
| `Permissions` | function |
| `Public` | function |
| `Query` | function |
| `registerParameterResolver` | function |
| `resolveParameter` | function |
| `resolveParameters` | function |
| `Roles` | function |
| `UseFilters` | function |
| `UseGuards` | function |
| `UseInterceptors` | function |
| `ValidateBody` | function |
| `ValidateParams` | function |
| `ValidateQuery` | function |
| `Version` | function |
| `MetadataStore` | class |
| `Delete` | const |
| `Get` | const |
| `Head` | const |
| `metadataStore` | const |
| `Options` | const |
| `Patch` | const |
| `Post` | const |
| `Put` | const |
| `ApiOperationConfig` | interface |
| `ApiResponseConfig` | interface |
| `DecoratorPluginOptions` | interface |
| `DiscoveryOptions` | interface |
| `DiscoveryResult` | interface |
| `InjectableOptions` | interface |
| `OptionalToken` | interface |
| `ParameterMetadata` | interface |
| `ParamSource` | interface |
| `CustomParameterResolver` | type |
| `HttpMethodDecorator` | type |
| `InjectToken` | type |
| `MiddlewareLike` | type |
| `ModuleImporter` | type |
| `ParameterType` | type |
| `SetuClassDecorator` | type |
| `SetuClassOrMethodDecorator` | type |
| `SetuMethodDecorator` | type |
| `SourceValues` | type |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsdecorator-plugin).

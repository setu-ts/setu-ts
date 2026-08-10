# @setu-ts/decorator-plugin

Optional NestJS-style decorators as syntactic sugar over the kernel's programmatic API.

Decorators capture metadata in a plain `MetadataStore` — **no `reflect-metadata`, no reflection
polyfill**. `DecoratorPlugin` reads that store at registration time and registers routes, services,
and middleware with the kernel. Decorators are inert unless the plugin is registered.

The store itself is registered under `CAPABILITIES.METADATA_STORE` (`'metadata-store'`).

## Installation

```typescript
import { Controller, DecoratorPlugin, Get } from '@setu-ts/decorator-plugin';
```

## Usage

```typescript
import { Body, Controller, DecoratorPlugin, Get, Param, Post } from '@setu-ts/decorator-plugin';

@Controller('/users')
class UsersController {
  @Get('/:id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Post('/')
  create(@Body() body: unknown) {
    return body;
  }
}

app.register(DecoratorPlugin({ controllers: [UsersController] }));
```

## What it exports

- **Routing** — `@Controller`, `@Version`,
  `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`/`@Head`/`@Options`
- **Parameters** — `@Body`, `@Query`, `@Param`, `@Header`, `@Cookie`
- **Injection** — `@Injectable`, `@Inject`, `@Optional`
- **Security** — `@Roles`, `@Permissions`, `@Public`, `@CurrentUser`
- **Pipeline** — `@UseGuards`, `@UseInterceptors`, `@UseFilters`
- **Validation** — `@ValidateBody`, `@ValidateQuery`, `@ValidateParams`
- **OpenAPI** — `@ApiTags`, `@ApiOperation`, `@ApiResponse`
- **Extension** — `createDecorator`, `createParameterDecorator`, `registerParameterResolver`
- **Discovery** — `discoverControllers`

## Options

| Option            | Type            | Default | Description                                   |
| ----------------- | --------------- | ------- | --------------------------------------------- |
| `controllers`     | `Constructor[]` | `[]`    | Controller classes to register explicitly.    |
| `services`        | `Constructor[]` | `[]`    | Service classes to register explicitly.       |
| `autoDiscover`    | `boolean`       | `false` | Scan `controllersPath` for decorated classes. |
| `controllersPath` | `string`        | —       | Glob path used when `autoDiscover` is `true`. |

Discovery failures are logged as warnings and never crash the application.

## Exports

| Export                      | Kind      |
| --------------------------- | --------- |
| `ApiOperation`              | function  |
| `ApiResponse`               | function  |
| `ApiTags`                   | function  |
| `Body`                      | function  |
| `clearParameterResolvers`   | function  |
| `Controller`                | function  |
| `Cookie`                    | function  |
| `createDecorator`           | function  |
| `createParameterDecorator`  | function  |
| `CurrentUser`               | function  |
| `DecoratorPlugin`           | function  |
| `discoverControllers`       | function  |
| `getParameterResolver`      | function  |
| `Header`                    | function  |
| `Inject`                    | function  |
| `Injectable`                | function  |
| `Optional`                  | function  |
| `Param`                     | function  |
| `parseCookies`              | function  |
| `Permissions`               | function  |
| `Public`                    | function  |
| `Query`                     | function  |
| `registerParameterResolver` | function  |
| `resolveParameter`          | function  |
| `resolveParameters`         | function  |
| `Roles`                     | function  |
| `UseFilters`                | function  |
| `UseGuards`                 | function  |
| `UseInterceptors`           | function  |
| `ValidateBody`              | function  |
| `ValidateParams`            | function  |
| `ValidateQuery`             | function  |
| `Version`                   | function  |
| `MetadataStore`             | class     |
| `Delete`                    | const     |
| `Get`                       | const     |
| `Head`                      | const     |
| `metadataStore`             | const     |
| `Options`                   | const     |
| `Patch`                     | const     |
| `Post`                      | const     |
| `Put`                       | const     |
| `ApiOperationConfig`        | interface |
| `ApiResponseConfig`         | interface |
| `DecoratorPluginOptions`    | interface |
| `DiscoveryOptions`          | interface |
| `DiscoveryResult`           | interface |
| `InjectableOptions`         | interface |
| `ParameterMetadata`         | interface |
| `CustomParameterResolver`   | type      |
| `HttpMethodDecorator`       | type      |
| `MiddlewareLike`            | type      |
| `ModuleImporter`            | type      |
| `ParameterType`             | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsdecorator-plugin).

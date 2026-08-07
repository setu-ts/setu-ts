# @hono-enterprise/decorator-plugin

Optional NestJS-style decorators as syntactic sugar over the kernel's programmatic API.

Decorators capture metadata in a plain `MetadataStore` — **no `reflect-metadata`, no reflection
polyfill**. `DecoratorPlugin` reads that store at registration time and registers routes, services,
and middleware with the kernel. Decorators are inert unless the plugin is registered.

The store itself is registered under `CAPABILITIES.METADATA_STORE` (`'metadata-store'`).

## Installation

```typescript
import { Controller, DecoratorPlugin, Get } from '@hono-enterprise/decorator-plugin';
```

## Usage

```typescript
import {
  Body,
  Controller,
  DecoratorPlugin,
  Get,
  Param,
  Post,
} from '@hono-enterprise/decorator-plugin';

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

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).

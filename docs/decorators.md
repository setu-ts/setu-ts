# Decorators Guide

The Setu-TS framework provides optional decorator support for a NestJS-like development experience.
Decorators are **optional** - all capabilities can be accessed programmatically.

## Overview

Decorators in Setu-TS are **metadata-only**. They do not automatically register routes or services.
The `DecoratorPlugin` reads the metadata and translates it into framework capabilities.

### Key Differences from NestJS

- **No reflection metadata**: Setu-TS does not use `reflect-metadata`. You must provide explicit
  injection tokens.
- **No emitted design metadata**: Constructor parameter types are not automatically available. Use
  `@Inject(Token)` for disambiguation.
- **Plugin-required**: Decorators are inert without `DecoratorPlugin` registration.
- **No `ExecutionContext`/`CanActivate`/`NestInterceptor`**: Setu-TS has no NestJS-shaped guard or
  interceptor interfaces. Guards and interceptors are bare
  [`MiddlewareFunction`](../packages/common/src/http.ts)s attached with `@UseGuards` /
  `@UseInterceptors` (or registered programmatically via `app.middleware.add`). Prose below explains
  the NestJS differences; the copyable Setu-TS blocks never import those NestJS names.

## Setup

### Install Dependencies

```bash
deno add jsr:@setu-ts/decorator-plugin jsr:@setu-ts/di-plugin
```

### Enable Decorators

In your `deno.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

### Register Plugins

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';

const app = createApplication();

app.register(RuntimePlugin());
app.register(DiPlugin()); // Optional: adds a container, so `scope` is honored
app.register(DecoratorPlugin()); // Required for decorator processing
```

`DecoratorPlugin` is required — decorators are inert without it. **`DiPlugin` is not.**
`DecoratorPlugin` branches on the container's presence: with `DiPlugin` registered, an `@Injectable`
class is constructed through the container and its `scope` is honored; without it, the class is
constructed once and registered in the kernel's `ServiceRegistry`. The decorated source is identical
either way — what changes is the lifecycle.

`setu new app --template class-based` scaffolds both together, which is the only combination the CLI
writes: the default templates install neither plugin, and the independent `--di` flag has been
removed. An older project may hold `DecoratorPlugin` alone, and it keeps working — that is the
container-less path described above. See the
[CLI Guide](./cli.md#decorators-and-di-are-one-choice-and-functional-is-the-default).

## Controllers

### Basic Controller

```typescript
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
} from '@setu-ts/decorator-plugin';

@Injectable({ token: 'user-service' })
export class UserService {
  findAll() {
    return [{ id: '1', name: 'Alice' }];
  }

  findById(id: string) {
    return { id, name: `user-${id}` };
  }

  create(dto: { name: string }) {
    return { id: '2', ...dto };
  }
}

@Controller('/users')
export class UserController {
  constructor(
    @Inject('user-service') private readonly userService: UserService,
  ) {}

  @Get()
  findAll() {
    return this.userService.findAll();
  }

  @Get('/:id')
  findOne(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Post()
  create(@Body() dto: { name: string }) {
    return this.userService.create(dto);
  }
}
```

Register the controller and service with the `DecoratorPlugin` so the metadata is translated into
routes and DI registrations:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { Body, Controller, Get, Inject, Injectable, Param, Post } from '@setu-ts/decorator-plugin';

@Injectable({ token: 'user-service' })
class UserService {
  findById(id: string) {
    return { id, name: `user-${id}` };
  }
}

@Controller('/users')
class UserController {
  constructor(
    @Inject('user-service') private readonly userService: UserService,
  ) {}

  @Get('/:id')
  findOne(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Post()
  create(@Body() dto: { name: string }) {
    return { id: '2', ...dto };
  }
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DiPlugin(),
    DecoratorPlugin({
      controllers: [UserController],
      services: [UserService],
    }),
  ],
});

await app.start({ port: 3000 });
```

### HTTP Method Decorators

| Decorator         | Method  | Path          |
| ----------------- | ------- | ------------- |
| `@Get(path?)`     | GET     | Optional path |
| `@Post(path?)`    | POST    | Optional path |
| `@Put(path?)`     | PUT     | Optional path |
| `@Patch(path?)`   | PATCH   | Optional path |
| `@Delete(path?)`  | DELETE  | Optional path |
| `@Head(path?)`    | HEAD    | Optional path |
| `@Options(path?)` | OPTIONS | Optional path |

Each method decorator accepts an optional path relative to the controller's base path and defaults
to `''`. Multiple HTTP decorators on the same method register one route per verb.

### Controller Options

`@Controller(path)` takes a base path prefix string. Combine it with `@Version('v1')` to add an API
version prefix; the effective path is `version + basePath + routePath` (e.g. `/v1/users`).

```typescript
import { Controller, Get, Version } from '@setu-ts/decorator-plugin';

@Controller('/api/users')
@Version('v1')
export class UserController {
  @Get()
  list() {
    return [];
  }
}
```

## Dependency Injection

### Injectable Classes

`@Injectable` and `@Inject` are the decorator-plugin's DI decorators (the `@setu-ts/di-plugin`
package ships the container, not decorators). `@Injectable` marks a class for registration with an
optional scope and token; `@Inject` declares a constructor-parameter token.

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

interface UserRepository {
  findAll(table: string): Promise<readonly { id: string; name: string }[]>;
}

@Injectable({ token: 'user-service' })
export class UserService {
  constructor(
    @Inject('user-repository') private readonly repo: UserRepository,
    @Inject(CAPABILITIES.CACHE) private readonly cache: ICacheStore,
  ) {}

  async findAll() {
    // Check cache first
    const cached = await this.cache.get<readonly { id: string; name: string }[]>('users:all');
    if (cached !== null) return cached;

    const users = await this.repo.findAll('users');
    await this.cache.set('users:all', users, 60);
    return users;
  }
}
```

**Where the instance lives depends on whether a container is present.** `DecoratorPlugin` registers
a provider on the container when `DiPlugin` is registered, and it never touches the kernel registry
in that case — so `ctx.services.get('user-service')` resolves an `@Injectable` class **only in a
project without `DiPlugin`**. With a container, reach it by injecting it
(`@Inject('user-service')`), which is the path that works under both compositions.

### Parameter-Level Injection

Setu-TS requires explicit tokens for parameter injection because type-inferred injection needs
`emitDecoratorMetadata`, which Deno does not support:

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

@Injectable()
export class UserRepository {
  // Preferred: one token per constructor parameter, bound by position.
  constructor(
    @Inject(CAPABILITIES.CACHE) private readonly cache: ICacheStore,
  ) {}
}
```

The deprecated class-level form takes a positional token list matching the constructor arguments and
is mutually exclusive with the parameter form (a class carrying both fails at `register()`):

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

@Injectable()
@Inject(CAPABILITIES.CACHE)
export class UserRepository {
  constructor(private readonly cache: ICacheStore) {}
}
```

### Optional Dependencies

`@Optional` pairs with `@Inject` on the same constructor parameter: when the token has no provider,
the argument receives `undefined` instead of failing construction. A token is still required.

```typescript
import { Inject, Injectable, Optional } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

@Injectable()
export class MyService {
  constructor(
    @Optional() @Inject(CAPABILITIES.CACHE) private readonly cache?: ICacheStore,
  ) {}
}
```

### Scoped Injection

`@Injectable` accepts a `scope` option using the `ServiceScope` string literal union
(`'singleton' | 'scoped' | 'transient'`) from `@setu-ts/common`. There is no `Scope` enum.

```typescript
import { Injectable } from '@setu-ts/decorator-plugin';

@Injectable({ scope: 'scoped' })
export class RequestScopedService {}
```

**Scopes:**

- `'singleton'` (default): Single instance per container
- `'scoped'`: New instance per request scope
- `'transient'`: New instance every injection

## Request Data Access

### Body

```typescript
import { Body, Controller, Post } from '@setu-ts/decorator-plugin';

interface CreateUserDto {
  name: string;
}

@Controller('/users')
export class UserController {
  @Post()
  async create(@Body() dto: CreateUserDto) {
    // dto is the parsed JSON body; validated when a schema is attached
    // with @ValidateBody and the ValidationPlugin is registered.
    return dto;
  }
}
```

### Query Parameters

```typescript
import { Controller, Get, Query } from '@setu-ts/decorator-plugin';

@Controller('/users')
export class UserController {
  @Get()
  async findAll(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    return { page: parseInt(page), limit: parseInt(limit) };
  }
}
```

### Path Parameters

```typescript
import { Controller, Get, Param } from '@setu-ts/decorator-plugin';

@Controller('/users')
export class UserController {
  @Get('/:id')
  async findOne(@Param('id') id: string) {
    return { id };
  }
}
```

### Headers

```typescript
import { Controller, Get, Header } from '@setu-ts/decorator-plugin';

@Controller('/users')
export class UserController {
  @Get()
  async list(@Header('Authorization') auth: string) {
    // auth contains "Bearer <token>" or "Basic <credentials>"
    return { hasAuth: auth !== null };
  }
}
```

### Cookies

```typescript
import { Controller, Cookie, Get } from '@setu-ts/decorator-plugin';

@Controller('/users')
export class UserController {
  @Get()
  async list(@Cookie('session') session: string) {
    return { session };
  }
}
```

### The Authenticated Principal

`@CurrentUser` injects `ctx.request.user` (populated by authentication middleware). There is no
`@Request()` or `@Context()` parameter decorator — to read the full context, use a custom parameter
decorator (see [Custom Decorators](#custom-decorators)).

```typescript
import { Controller, CurrentUser, Get } from '@setu-ts/decorator-plugin';
import type { IPrincipal } from '@setu-ts/common';

@Controller('/me')
export class MeController {
  @Get()
  async info(@CurrentUser() user: IPrincipal) {
    return { user };
  }
}
```

## Validation

`@ValidateBody`, `@ValidateQuery`, and `@ValidateParams` attach a schema to a route. The schema is
stored on the route metadata and enforced only when the `ValidationPlugin` (or another schema-aware
middleware) is registered; without it the schema is inert.

```typescript
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  ValidateBody,
  ValidateQuery,
} from '@setu-ts/decorator-plugin';

// A validation schema is a plain object (Zod schema by convention); it is a
// VALUE, not a type, so @ValidateBody can attach it to the route metadata.
const createUserSchema = {
  name: { type: 'string' as const, required: true },
  email: { type: 'string' as const, required: true },
};

interface CreateUserDto {
  name: string;
  email: string;
}

@Controller('/users')
export class UserController {
  @Post()
  @ValidateBody(createUserSchema)
  async create(@Body() dto: CreateUserDto) {
    // dto is already validated
    return dto;
  }

  @Get()
  @ValidateQuery({
    page: { type: 'number', optional: true, default: 1 },
    limit: { type: 'number', optional: true, default: 10 },
  })
  async list(@Query() query: Record<string, unknown>) {
    // query is validated
    return query;
  }
}
```

For programmatic (non-decorator) validation, the `@setu-ts/validation-plugin` package exports
`validateBody` and `validateQuery` middleware helpers used directly in route middleware arrays.

## Guards

Setu-TS has no `CanActivate` interface or `ExecutionContext`. Guards are bare `MiddlewareFunction`s
(or `IMiddleware` classes) attached with `@UseGuards`, which may short-circuit by responding without
calling `next()`.

```typescript
import { Controller, Get, UseGuards } from '@setu-ts/decorator-plugin';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

const authGuard: MiddlewareFunction = async (ctx, next) => {
  const authHeader = ctx.request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return ctx.response.status(401).json({ error: 'Unauthorized' });
  }
  await next();
};

@Controller('/users')
export class UserController {
  @Get('/protected')
  @UseGuards(authGuard)
  async protected() {
    return { message: 'This is protected' };
  }
}
```

### Authorization Metadata

`@Roles`, `@Permissions`, and `@Public` attach authorization metadata to a route. The metadata is
stored but **not** enforced by this plugin; enforcement is the responsibility of guard middleware
registered by the auth plugin (e.g. `requireAuth`, `requireRole`, `requirePermission` from
`@setu-ts/auth-plugin`). `@Public` takes precedence over `@Roles`/`@Permissions` on the same target.

```typescript
import { Controller, Get, Permissions, Public, Roles } from '@setu-ts/decorator-plugin';

@Controller('/admin')
export class AdminController {
  @Get('/public')
  @Public()
  async publicInfo() {
    return { info: 'public' };
  }

  @Get('/users')
  @Roles('admin')
  async listUsers() {
    return [];
  }

  @Get('/reports')
  @Permissions('reports:read')
  async reports() {
    return [];
  }
}
```

## Interceptors

Setu-TS has no `NestInterceptor` interface. Interceptors are bare `MiddlewareFunction`s (or
`IMiddleware` classes) attached with `@UseInterceptors` that wrap the handler invocation via
`next()`.

```typescript
import { Controller, Get, UseInterceptors } from '@setu-ts/decorator-plugin';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

const transformInterceptor: MiddlewareFunction = async (ctx, next) => {
  await next();
  const snapshot = ctx.response.snapshot();
  if (!snapshot.streaming && snapshot.body !== null) {
    const data = typeof snapshot.body === 'string' ? JSON.parse(snapshot.body) : snapshot.body;
    return ctx.response.json({ success: true, data });
  }
};

@Controller('/users')
export class UserController {
  @Get()
  @UseInterceptors(transformInterceptor)
  async list() {
    return [{ id: '1', name: 'Alice' }];
  }
}
```

## Error Handling

Setu-TS does not ship a NestJS-shaped `ExceptionFilter`/`ArgumentsHost` contract. Errors are handled
by a single global error-handler middleware from `@setu-ts/exceptions`, registered as the outermost
middleware so it wraps the whole pipeline. The `@UseFilters(...)` decorator attaches per-route
filter middleware (bare `MiddlewareFunction`s or `IMiddleware` classes) that run last in the route's
middleware chain, but the canonical, source-valid surface for global error handling is
`errorHandler()`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';

const app = createApplication();
app.register(RuntimePlugin());

// Register the error handler as the outermost middleware (lowest priority
// number) so it catches errors thrown by any downstream middleware or route
// handler, formats them, and sends the response.
app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: true }), {
  priority: 0,
  name: 'error-handler',
});
```

For per-route error handling, attach a filter middleware with `@UseFilters`:

```typescript
import { Controller, Get, UseFilters } from '@setu-ts/decorator-plugin';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

const routeErrorHandler: MiddlewareFunction = async (ctx, next) => {
  try {
    await next();
  } catch (_error) {
    return ctx.response.status(500).json({ error: 'route failure' });
  }
};

@Controller('/risky')
export class RiskyController {
  @Get()
  @UseFilters(routeErrorHandler)
  async risky() {
    // Errors thrown here are caught by routeErrorHandler.
    return { ok: true };
  }
}
```

## Custom Decorators

### Parameter Decorator

`createParameterDecorator(name, metadata?)` stores a custom parameter resolved at request time by a
resolver registered under the same `name` via `registerParameterResolver`. There is no
`ExecutionContext`/`switchToHttp` surface — the resolver receives the `IRequestContext` directly:

```typescript
import {
  Controller,
  createParameterDecorator,
  Get,
  registerParameterResolver,
} from '@setu-ts/decorator-plugin';
import type { IRequestContext } from '@setu-ts/common';

export const TenantId = () => createParameterDecorator('tenant-id');

// Register the resolver that reads the tenant id from the request context.
// The registered name must match the decorator's name.
registerParameterResolver('tenant-id', (ctx: IRequestContext) => ctx.request.tenant?.id);

@Controller('/items')
export class ItemController {
  @Get()
  async list(@TenantId() tenantId: unknown) {
    return { tenantId };
  }
}
```

### Method/Class Decorator

`createDecorator(name, metadata)` stores class/method metadata replayed at registration time against
handlers registered under `CAPABILITIES.DECORATOR_HANDLER`.

```typescript
import { Controller, createDecorator, Get } from '@setu-ts/decorator-plugin';

interface LoggingOptions {
  level: 'info' | 'debug';
}

export const Log = (options?: LoggingOptions) =>
  createDecorator('app:log', { level: options?.level ?? 'info' });

@Controller('/items')
export class ItemController {
  @Log({ level: 'debug' })
  @Get()
  async list() {
    return [];
  }
}
```

## Metadata Store

The `MetadataStore` is a plain `Map`-backed store keyed by class reference. Decorators write to the
shared `metadataStore` singleton at class-definition time; the `DecoratorPlugin` registers that
instance under `CAPABILITIES.METADATA_STORE` so `ctx.metadata` resolves to it. It exposes readonly
`controllers`, `services`, and `routes` maps plus lookup and mutation methods — there is no
`set`/`get` key-value API.

```typescript
import { MetadataStore } from '@setu-ts/decorator-plugin';

const store = new MetadataStore();

// Inspect registered controllers and their materialized routes.
for (const [target, routes] of store.routes) {
  console.log(target.name, routes.length, 'route(s)');
}
```

## Discovery

Discover all controllers automatically with `discoverControllers`, which scans a directory and
imports files, attributing newly-appeared decorated classes to each file:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DiPlugin(),
    DecoratorPlugin({
      autoDiscover: true,
      controllersPath: './src/controllers',
    }),
  ],
});

await app.start({ port: 3000 });
```

## Limitations

### No `reflect-metadata`

Setu-TS does not emit design metadata. You must provide explicit tokens:

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

// ❌ This won't work - type information is not available
@Injectable()
class UserRepository {
  constructor(private readonly cache: ICacheStore) {}
}

// ✅ Provide explicit token
@Injectable()
class UserRepositoryOk {
  constructor(@Inject(CAPABILITIES.CACHE) private readonly cache: ICacheStore) {}
}
```

### No Automatic Registration

Decorators only add metadata. You must:

1. Register `DecoratorPlugin` — required; nothing reads the metadata without it
2. Register controllers and services with the plugin, or use `autoDiscover: true`

`DiPlugin` is **not** on that list: injection works without a container, which resolves from the
kernel's `ServiceRegistry` instead. Register it when you want a scoped or transient lifecycle.

### No Method Overloading

Each decorator registers one route. For multiple methods, use separate methods:

```typescript
import { Controller, Get, Post } from '@setu-ts/decorator-plugin';

@Controller('/items')
export class ItemController {
  @Get('/items')
  async getItems() {
    return [];
  }

  @Post('/items')
  async createItem() {
    return { created: true };
  }
}
```

## Programmatic Equivalent

Every decorator has a programmatic equivalent:

| Decorator                       | Programmatic                                            |
| ------------------------------- | ------------------------------------------------------- |
| `@Controller('/path')`          | `app.router.get('/path', handler)`                      |
| `@Injectable()`                 | `ctx.services.register('token', instance)`              |
| `@Inject('token')`              | N/A (injection configuration)                           |
| `@UseGuards(Guard)`             | Middleware: `app.middleware.add(guardMiddleware)`       |
| `@UseInterceptors(Interceptor)` | Middleware: `app.middleware.add(interceptorMiddleware)` |
| `@UseFilters(Filter)`           | Exception handler: `app.middleware.add(errorHandler)`   |

## Examples

### Complete REST Controller

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  Query,
  Roles,
  UseGuards,
  ValidateBody,
} from '@setu-ts/decorator-plugin';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

const createUserSchema = {
  name: { type: 'string' as const, required: true },
  email: { type: 'string' as const, required: true },
};

interface CreateUserDto {
  name: string;
  email: string;
}

@Injectable({ token: 'user-service' })
export class UserService {
  findAll(_opts: { page: number }) {
    return [{ id: '1', name: 'Alice' }];
  }

  findById(id: string) {
    return { id, name: `user-${id}` };
  }

  create(dto: CreateUserDto) {
    return { id: '2', ...dto };
  }

  update(id: string, dto: CreateUserDto) {
    return { id, ...dto };
  }

  async delete(_id: string) {
    return { deleted: true };
  }
}

const authGuard: MiddlewareFunction = async (ctx: IRequestContext, next) => {
  const authHeader = ctx.request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return ctx.response.status(401).json({ error: 'Unauthorized' });
  }
  await next();
};

@Controller('/api/users')
@UseGuards(authGuard)
@Roles('admin')
export class UserController {
  constructor(
    @Inject('user-service') private readonly userService: UserService,
  ) {}

  @Get()
  async findAll(@Query('page') page: string = '1') {
    return this.userService.findAll({ page: parseInt(page) });
  }

  @Get('/:id')
  async findOne(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Post()
  @ValidateBody(createUserSchema)
  async create(@Body() dto: CreateUserDto) {
    return this.userService.create(dto);
  }

  @Put('/:id')
  async update(@Param('id') id: string, @Body() dto: CreateUserDto) {
    return this.userService.update(id, dto);
  }

  @Delete('/:id')
  async delete(@Param('id') id: string) {
    await this.userService.delete(id);
    return { deleted: true };
  }
}
```

## Next Steps

- [Programmatic API](./programmatic-api.md) - Complete API reference without decorators
- [Plugin Architecture](./plugin-architecture.md) - Understanding the underlying system

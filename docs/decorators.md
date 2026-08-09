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
  `@inject(Token)` for disambiguation.
- **Plugin-required**: Decorators are inert without `DecoratorPlugin` registration.

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
app.register(DiPlugin()); // Required for dependency injection
app.register(DecoratorPlugin()); // Required for decorator processing
```

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

### Controller Options

```typescript
@Controller({
  path: '/api/users',
  produces: ['application/json'],
  consumes: ['application/json'],
})
export class UserController {}
```

## Dependency Injection

### Injectable Classes

```typescript
import { inject, injectable } from '@setu-ts/di-plugin';

@injectable()
export class UserService {
  constructor(
    @inject('DatabaseService') private readonly db: DatabaseService,
    @inject('CacheService') private readonly cache: CacheService,
  ) {}

  async findAll() {
    // Check cache first
    const cached = await this.cache.get('users:all');
    if (cached) return cached;

    const users = await this.db.findAll('users');
    await this.cache.set('users:all', users, { ttl: 60 });
    return users;
  }
}
```

### Parameter-Level Injection

Setu-TS requires explicit tokens for parameter injection:

```typescript
// Preferred: Parameter-level injection
constructor(
  @inject('DatabaseService') private readonly db: DatabaseService,
) {}

// Deprecated: Class-level tokens (still supported)
@injectable()
@inject('DatabaseService')
constructor(private readonly db: DatabaseService) {}
```

### Optional Dependencies

```typescript
import { injectOptional } from '@setu-ts/di-plugin';

@injectable()
export class MyService {
  constructor(
    @injectOptional('OptionalService') private readonly optional?: OptionalService,
  ) {}
}
```

### Scoped Injection

```typescript
import { injectable, Scope } from '@setu-ts/di-plugin';

@injectable({ scope: Scope.REQUEST })
export class RequestScopedService {}
```

**Scopes:**

- `Scope.SINGLETON` (default): Single instance per container
- `Scope.REQUEST`: New instance per request
- `Scope.TRANSIENT`: New instance every injection

## Request Data Access

### Body

```typescript
@Post()
async create(@Body() dto: CreateUserDto) {
  // dto is validated if validation plugin is registered
}

@Post()
async create(@Body('email') email: string) {
  // Extract nested property
}
```

### Query Parameters

```typescript
@Get()
async findAll(
  @Query('page') page: string = '1',
  @Query('limit') limit: string = '10',
) {
  return this.userService.findAll({
    page: parseInt(page),
    limit: parseInt(limit),
  });
}
```

### Path Parameters

```typescript
@Get('/:id')
async findOne(@Param('id') id: string) {
  return this.userService.findById(id);
}
```

### Headers

```typescript
@Get()
async list(@Header('Authorization') auth: string) {
  // auth contains "Bearer <token>" or "Basic <credentials>"
}
```

### Full Request

```typescript
@Post()
async create(@Request() req: IRequest) {
  console.log('Method:', req.method);
  console.log('URL:', req.url);
}
```

### Context

```typescript
@Get()
async info(@Context() ctx: IRequestContext) {
  console.log('Request ID:', ctx.id);
  console.log('User:', ctx.user);
}
```

## Validation

With `ValidationPlugin` registered:

```typescript
import { validateBody, validateQuery } from '@setu-ts/validation-plugin';

@Post()
@validateBody(CreateUserDto)
async create(@Body() dto: CreateUserDto) {
  // dto is already validated
}

@Get()
@validateQuery({
  page: { type: 'number', optional: true, default: 1 },
  limit: { type: 'number', optional: true, default: 10 },
})
async list(@Query() query: Record<string, unknown>) {
  // query is validated
}
```

## Guards

Guards determine if a route handler should execute.

```typescript
import { CanActivate, ExecutionContext } from '@setu-ts/decorator-plugin';

export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const authHeader = ctx.request.headers.get('Authorization');
    return authHeader?.startsWith('Bearer ') ?? false;
  }
}

@Get('/protected')
@useGuards(AuthGuard)
async protected() {
  return { message: 'This is protected' };
}
```

### Built-in Guards

- `@Public()` - Skip authentication
- `@RequireAuth()` - Require authentication
- `@RequireRole(...roles)` - Require specific roles
- `@RequirePermission(...permissions)` - Require specific permissions

## Interceptors

Interceptors can transform requests and responses.

```typescript
import { NestInterceptor, ExecutionContext } from '@setu-ts/decorator-plugin';

export class TransformInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: () => Promise<unknown>): Promise<unknown> {
    return next().then((data) => ({
      success: true,
      data,
      timestamp: ctx.runtime.now(),
    }));
  }
}

@Get()
@useInterceptors(TransformInterceptor)
async list() {
  return this.userService.findAll();
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
app.middleware.add(errorHandler({ format: 'rfc7807', logErrors: true }), {
  priority: 0,
  name: 'error-handler',
});
```

For per-route error handling, attach a filter middleware with `@UseFilters`:

```typescript
import { Controller, Get, UseFilters } from '@setu-ts/decorator-plugin';
import type { IRequestContext } from '@setu-ts/common';

const routeErrorHandler = async (ctx: IRequestContext, next: () => Promise<void>) => {
  try {
    await next();
  } catch (error) {
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
import { createParameterDecorator, registerParameterResolver } from '@setu-ts/decorator-plugin';

export const CurrentUser = () => createParameterDecorator('current-user');

// Register the resolver that reads the authenticated principal from the
// request context. The registered name must match the decorator's name.
registerParameterResolver('current-user', (ctx) => ctx.request.user);

@Controller('/me')
export class MeController {
  @Get()
  async info(@CurrentUser() user: unknown) {
    return { user };
  }
}
```

### Method/Class Decorator

```typescript
import { createDecorator } from '@setu-ts/decorator-plugin';

interface LoggingOptions {
  level: 'info' | 'debug';
}

export const Log = (options?: LoggingOptions) =>
  createDecorator<LoggingOptions>({
    key: 'logging',
    options: options ?? { level: 'info' },
    handler: (metadata, ctx) => {
      console.log(`[${metadata.options.level}] ${ctx.request.method} ${ctx.request.path}`);
    },
  });

@Log({ level: 'debug' })
@Get()
async list() {
  return this.userService.findAll();
}
```

## Metadata Store

Access the metadata store directly:

```typescript
import { MetadataStore } from '@setu-ts/decorator-plugin';

const metadata = new MetadataStore();

metadata.set('MyClass', 'custom-key', { foo: 'bar' });
const value = metadata.get('MyClass', 'custom-key');
```

## Discovery

Discover all controllers automatically:

```typescript
import { discoverControllers } from '@setu-ts/decorator-plugin';

await discoverControllers(app, {
  baseDir: './src/controllers',
  filter: (path) => path.endsWith('.controller.ts'),
});
```

## Limitations

### No `reflect-metadata`

Setu-TS does not emit design metadata. You must provide explicit tokens:

```typescript
// ❌ This won't work - type information is not available
constructor(private readonly db: DatabaseService) {}

// ✅ Provide explicit token
constructor(@inject('DatabaseService') private readonly db: DatabaseService) {}
```

### No Automatic Registration

Decorators only add metadata. You must:

1. Register `DecoratorPlugin`
2. Register `DiPlugin` (for injection)
3. Register controllers manually or use `discoverControllers()`

### No Method Overloading

Each decorator registers one route. For multiple methods, use multiple decorators:

```typescript
@Get('/items')
@Post('/items')
async handleItems() {
  // This won't work as expected
}

// Use separate methods
@Get('/items')
async getItems() {}

@Post('/items')
async createItem() {}
```

## Programmatic Equivalent

Every decorator has a programmatic equivalent:

| Decorator                       | Programmatic                                            |
| ------------------------------- | ------------------------------------------------------- |
| `@Controller('/path')`          | `app.router.get('/path', handler)`                      |
| `@injectable()`                 | `ctx.services.register('token', instance)`              |
| `@inject('token')`              | N/A (injection configuration)                           |
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
  inject,
  injectable,
  Param,
  Post,
  Put,
  Query,
  RequireAuth,
  useGuards,
  validateBody,
} from '@setu-ts/decorator-plugin';

interface CreateUserDto {
  name: string;
  email: string;
}

@Controller('/api/users')
@injectable()
@useGuards(RequireAuth())
export class UserController {
  constructor(
    @inject('UserService') private readonly userService: UserService,
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
  @validateBody(CreateUserDto)
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

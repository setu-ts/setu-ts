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

await app.register(RuntimePlugin);
await app.register(DiPlugin); // Required for dependency injection
await app.register(DecoratorPlugin); // Required for decorator processing
```

## Controllers

### Basic Controller

```typescript
import { Body, Controller, Get, Param, Post, Query } from '@setu-ts/decorator-plugin';
import { inject, injectable } from '@setu-ts/di-plugin';

@Controller('/users')
@injectable()
export class UserController {
  constructor(
    @inject('UserService') private readonly userService: UserService,
  ) {}

  @Get()
  async findAll() {
    return this.userService.findAll();
  }

  @Get('/:id')
  async findOne(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    return this.userService.create(dto);
  }
}
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
      timestamp: Date.now(),
    }));
  }
}

@Get()
@useInterceptors(TransformInterceptor)
async list() {
  return this.userService.findAll();
}
```

## Exception Filters

Exception filters handle errors globally or per-route.

```typescript
import { ExceptionFilter, ArgumentsHost } from '@setu-ts/decorator-plugin';

export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        message: exception.message,
      });
    }
  }
}

@UseFilters(HttpExceptionFilter)
@Get()
async risky() {
  // Exceptions handled by HttpExceptionFilter
}
```

## Custom Decorators

### Parameter Decorator

```typescript
import { createParamDecorator } from '@setu-ts/decorator-plugin';

export const CurrentUser = createParamDecorator((ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().context.user;
});

@Get()
async info(@CurrentUser() user: unknown) {
  return { user };
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

| Decorator                       | Programmatic                                          |
| ------------------------------- | ----------------------------------------------------- |
| `@Controller('/path')`          | `app.get('/path', handler)`                           |
| `@injectable()`                 | `ctx.services.register('token', instance)`            |
| `@inject('token')`              | N/A (injection configuration)                         |
| `@UseGuards(Guard)`             | Middleware: `app.use(guardMiddleware)`                |
| `@UseInterceptors(Interceptor)` | Middleware: `app.use(interceptorMiddleware)`          |
| `@UseFilters(Filter)`           | Exception handler: `ctx.middleware.add(errorHandler)` |

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

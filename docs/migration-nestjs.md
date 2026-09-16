# Migrating from NestJS

This guide helps you migrate from NestJS to Setu-TS. Setu-TS provides a familiar developer
experience with decorators and dependency injection while being runtime-independent and more
flexible.

## Key Differences

| Concept                  | NestJS                      | Setu-TS                                   |
| ------------------------ | --------------------------- | ----------------------------------------- |
| **Runtime**              | Node.js only                | Deno, Node.js, Bun, Cloudflare Workers    |
| **Reflection**           | `reflect-metadata` required | Explicit injection tokens (no reflection) |
| **Module System**        | `@Module` decorators        | Plugin composition                        |
| **HTTP Server**          | Express/Fastify             | Hono (fetch API)                          |
| **Dependency Injection** | Automatic via reflection    | Explicit tokens (`@Inject('token')`)      |
| **Decorators**           | Built-in                    | Optional, via `DecoratorPlugin`           |

## Basic Application

### NestJS

```typescript
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Module } from '@nestjs/common';

@Controller()
class AppController {
  @Get()
  hello() {
    return { message: 'Hello' };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
void bootstrap();
```

### Setu-TS (Programmatic)

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();

app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello' });
});

await app.start({ port: 3000 });
```

### Setu-TS (With Decorators)

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { Controller, DecoratorPlugin, Get } from '@setu-ts/decorator-plugin';

@Controller('/')
class AppController {
  @Get()
  async hello() {
    return { message: 'Hello' };
  }
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DiPlugin(),
    DecoratorPlugin({ controllers: [AppController] }),
  ],
});

await app.start({ port: 3000 });
```

## Controllers and Routes

### NestJS

```typescript
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateUserDto } from './create-user.dto';
import { UserService } from './user.service';

@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @Get()
  findAll() {
    return this.userService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.userService.create(dto);
  }
}
```

### Setu-TS (Programmatic)

```typescript
import { createCapabilityToken } from '@setu-ts/common';

const USER_SERVICE = createCapabilityToken('user-service');

app.router.get('/users', async (ctx) => {
  const userService = ctx.services.get<UserService>(USER_SERVICE);
  return ctx.response.json(await userService.findAll());
});

app.router.get('/users/:id', async (ctx) => {
  const userService = ctx.services.get<UserService>(USER_SERVICE);
  const id = ctx.params.id;
  return ctx.response.json(await userService.findById(id));
});

app.router.post('/users', async (ctx) => {
  const userService = ctx.services.get<UserService>(USER_SERVICE);
  const dto = await ctx.request.json();
  return ctx.response.status(201).json(await userService.create(dto));
});
```

### Setu-TS (With Decorators)

```typescript
import { Body, Controller, Get, Inject, Param, Params, Post } from '@setu-ts/decorator-plugin';

@Controller('/users')
@Inject('user-service')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async findAll() {
    return this.userService.findAll();
  }

  @Get('/:id')
  @Params(Param('id'))
  async findOne(id: string) {
    return this.userService.findById(id);
  }

  @Post()
  @Params(Body())
  async create(dto: CreateUserDto) {
    return this.userService.create(dto);
  }
}
```

## Dependency Injection

### NestJS

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private readonly userRepository: Repository<User>) {}
}
```

### Setu-TS

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';

@Injectable({ token: 'user-service' })
@Inject('user-repository')
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}
}

// Register the service with the DecoratorPlugin, or programmatically:
ctx.services.register('user-service', new UserService(userRepository));
```

## Modules vs Plugins

### NestJS

```typescript
import { Module } from '@nestjs/common';

@Module({
  controllers: [UsersController],
  providers: [UserService],
  exports: [UserService],
})
export class UsersModule {}

// In AppModule
@Module({
  imports: [UsersModule, DatabaseModule],
})
export class AppModule {}
```

### Setu-TS

```typescript
import { DecoratorPlugin, Module } from '@setu-ts/decorator-plugin';

class UsersController {}
class UserService {}

@Module({
  controllers: [UsersController],
  providers: [UserService],
})
export class UsersModule {}

@Module({ imports: [UsersModule] })
export class AppModule {}

app.register(DecoratorPlugin({ modules: [AppModule] }));
```

`@Module` groups domain classes inside one application. It has no `exports` member because Setu-TS
does not create a module-scoped service registry or DI container: a provider registered by one
module is already visible to the rest of that application.

Use a plugin factory instead for a self-contained capability that owns lifecycle work, publishes a
capability, or should be reusable across applications:

```typescript
import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { DatabasePlugin } from '@setu-ts/database-plugin';

const USER_SERVICE = createCapabilityToken('user-service');

export function UsersPlugin(): IPlugin {
  return {
    name: 'users',
    version: '1.0.0',
    dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.DATABASE],
    provides: [USER_SERVICE],
    async register(ctx) {
      // Register services
      ctx.services.register(USER_SERVICE, new UserService());

      // Register routes directly
      ctx.router.get('/users', async (requestCtx) => {
        const userService = requestCtx.services.get<UserService>(USER_SERVICE);
        return requestCtx.response.json(await userService.findAll());
      });
    },
  };
}

// In main.ts
app.register(UsersPlugin());
app.register(DatabasePlugin());
```

## Guards

### NestJS

```typescript
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const token = this.extractTokenFromHeader(request);
    return !!token;
  }

  private extractTokenFromHeader(request: { headers: { authorization?: string } }): string | null {
    const [kind, token] = request.headers.authorization?.split(' ') ?? [];
    return kind === 'Bearer' && token !== undefined ? token : null;
  }
}
```

### Setu-TS

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';

export const authMiddleware: MiddlewareFunction = async (ctx, next) => {
  const authHeader = ctx.request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return ctx.response.status(401).json({ error: 'Unauthorized' });
  }

  // Verify token and set user
  const user = await verifyToken(token);
  ctx.state.set('user', user);

  await next();
};

// Use middleware
app.middleware.add(authMiddleware);
```

## Interceptors

### NestJS

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    void context;
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
      })),
    );
  }
}
```

### Setu-TS

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';

export const transformMiddleware: MiddlewareFunction = async (ctx, next) => {
  await next();

  // Transform response
  const snapshot = ctx.response.snapshot();
  if (!snapshot.streaming && typeof snapshot.body === 'string') {
    const data = JSON.parse(snapshot.body);
    const transformed = { success: true, data };
    return ctx.response.json(transformed);
  }
};
```

## Exception Filters

### NestJS

```typescript
import { ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception.getStatus();
    const message = exception.message;

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
```

### Setu-TS

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';
import { HttpError } from '@setu-ts/exceptions';

export const errorMiddleware: MiddlewareFunction = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof HttpError) {
      return ctx.response.status(error.statusCode).json(
        {
          statusCode: error.statusCode,
          timestamp: new Date().toISOString(),
          path: new URL(ctx.request.url).pathname,
          message: error.message,
        },
      );
    }

    // Log error
    console.error('Unhandled error', { error });

    return ctx.response.status(500).json(
      {
        statusCode: 500,
        message: 'Internal server error',
      },
    );
  }
};
```

## Pipelines (Validation)

### NestJS

```typescript
import { Body, Post, UsePipes, ValidationPipe } from '@nestjs/common';

@Post()
@UsePipes(new ValidationPipe())
async create(@Body() createDto: CreateCatDto) {
  // dto is validated
}
```

### Setu-TS

```typescript
import { validateBody } from '@setu-ts/validation-plugin';
import { validatedStateKey } from '@setu-ts/common';

app.router.post('/users', {
  middleware: [validateBody(CreateUserDto)],
  handler: async (ctx) => {
    const dto = ctx.state.get(validatedStateKey('body'));
    // dto is the value validated and parsed by the middleware
    return ctx.response.json({ created: dto });
  },
});
```

## Configuration

### NestJS

```typescript
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
})
export class AppModule {}

// Usage
@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}
}
```

### Setu-TS

```typescript
import { CAPABILITIES, type IConfig } from '@setu-ts/common';
import { ConfigPlugin } from '@setu-ts/config-plugin';

app.register(ConfigPlugin({
  // Optional: load .env files before reading `runtime.env` (requires a
  // runtime with filesystem support). Validate with a structural schema
  // (e.g. Zod) via `validationSchema` — `ConfigPluginOptions` has no `validate`
  // field.
  envFilePath: '.env',
}));

// Usage
const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
const port = config.get('PORT');
```

## Database (TypeORM → Prisma/Drizzle)

### NestJS (TypeORM)

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}

@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  async findAll() {
    return this.repo.find();
  }
}
```

### Setu-TS (Database Plugin)

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import { DatabasePlugin, type IDatabaseService } from '@setu-ts/database-plugin';

// The built-in arm selects the ORM via `type`; adapter-specific config lives
// under `options` (a `DatabaseAdapterOptions`), not a top-level `prisma`
// field. For Prisma v7, generate and construct the client in application code,
// then inject it through `options.prismaClient`; its generated output path is
// application-owned and cannot be located by this package.
//
// In a real application this import points at your own `prisma generate`
// output, e.g. `import { PrismaClient } from './generated/prisma/client.ts';`
declare const myPrismaClient: unknown;

app.register(DatabasePlugin({
  type: 'prisma',
  options: {
    prismaClient: myPrismaClient,
  },
}));

// Usage — IDatabaseService.getRepository() returns IRepository, not raw CRUD.
const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
const usersRepo = db.getRepository<{ id: string; name: string }>('users');
const users = await usersRepo.findAll();
```

## Caching

### NestJS

```typescript
import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';

@Controller('users')
@UseInterceptors(CacheInterceptor)
@CacheTTL(300_000)
export class UsersController {
  @Get()
  findAll() {
    // GET responses are cached for five minutes.
    return [];
  }
}
```

### Setu-TS

```typescript
import { CachePlugin } from '@setu-ts/cache-plugin';

// `store` selects the backend; store-specific config lives under `options`
// (a `CacheStoreOptions`), not a top-level `redis` field. For Redis, pass the
// connection URL (or inject an ioredis-compatible `client`).
app.register(CachePlugin({
  store: 'redis',
  options: { url: 'redis://localhost:6379' },
}));

// Usage — ICacheStore uses the token 'cache' (CAPABILITIES.CACHE), stores value
// with numeric TTL seconds (not an options bag), and deletes with delete().
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';
const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
const users: unknown[] = [];
await cache.set('users:all', users, 300);
const cachedUsers = await cache.get<unknown[]>('users:all');
await cache.delete('users:all');
```

## Validation

### NestJS

```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

class CreateUserDto {
  @IsString()
  @MinLength(3)
  name: string;

  @IsEmail()
  email: string;
}
```

### Setu-TS

```typescript
import { z } from 'zod';
import { ValidationPlugin } from '@setu-ts/validation-plugin';

const CreateUserDto = z.object({
  name: z.string().min(3),
  email: z.string().email(),
});

// Usage with validation plugin
app.register(ValidationPlugin({
  errorFormat: 'default',
}));

// Or manual validation
app.router.post('/users', async (ctx) => {
  const result = CreateUserDto.safeParse(await ctx.request.json());
  if (!result.success) {
    return ctx.response.status(400).json({ errors: result.error.issues });
  }
  const dto = result.data;
  return ctx.response.status(201).json({ created: dto });
});
```

## Views

### NestJS

`@Render('users/index')` names a template by path; the view engine resolves the file, and the string
is checked against nothing — a typo in the template name or a missing props field surfaces at
runtime.

```typescript
import { Controller, Get, Render } from '@nestjs/common';
import { UserService } from './user.service';

@Controller('pages')
export class PagesController {
  constructor(private readonly usersService: UserService) {}

  @Get('users')
  @Render('users/index')
  async users() {
    return { users: await this.usersService.findAll() };
  }
}
```

### Setu-TS

`@Render(Component)` names the view BY REFERENCE — a function the application already has — so there
is no view resolver and no filesystem lookup. The decorator type-checks the handler's return against
the component's props, so the mistake NestJS catches at runtime is a compile error here. The engine
comes from `@setu-ts/view-plugin` (registers under `CAPABILITIES.VIEW`); a rendered route with no
provider fails at `register()`, never serving JSON where the author asked for HTML. A status code or
header alongside a rendered body goes through the positional context source: the return value IS the
props bag, so `@Render` carries no `status` argument.

```tsx
import { Controller, Ctx, Get, Params, Render } from '@setu-ts/decorator-plugin';
import type { IRequestContext } from '@setu-ts/common';

// JSX, so every interpolation is escaped by the rendering runtime. A plain
// template literal is a `string`, returned unchanged with nothing escaped.
const UserList = (props: { readonly users: readonly string[] }) => (
  <ul>{props.users.map((user) => <li>{user}</li>)}</ul>
);

@Controller('/pages')
export class PagesController {
  @Render(UserList)
  @Get('/users')
  users(): { readonly users: readonly string[] } {
    return { users: ['ada', 'grace'] }; // the props bag — the framework answers HTML
  }

  @Render(UserList)
  @Params(Ctx())
  @Get('/created')
  created(ctx: IRequestContext): { readonly users: readonly string[] } {
    ctx.response.status(201); // through the context, not through @Render
    return { users: ['new'] };
  }
}
```

## WebSocket

### NestJS

```typescript
import { Server, Socket } from 'socket.io';
import { SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';

@WebSocketGateway()
export class EventsGateway {
  @WebSocketServer()
  private readonly server: Server;

  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: string): void {
    this.server.emit('response', payload);
  }
}
```

### Setu-TS

```typescript
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';

// WebSocketPlugin options carry heartbeat/idle/limit knobs only — routes and
// rooms are application-level, registered on the WebSocketService after the
// plugin (no `rooms` plugin option exists).
app.register(WebSocketPlugin({ heartbeatMs: 30_000 }));
await app.start({ port: 3000 });

const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
ws.route('/ws', {
  onOpen: (conn) => {
    console.log('Client connected');
    ws.room('events').add(conn);
  },
  onMessage: (conn, message) => {
    ws.room('events').broadcast(message, { except: conn });
  },
});
```

## Testing

### NestJS

```typescript
import { Test } from '@nestjs/testing';

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{
        provide: UserService,
        useValue: {
          findAll: () => [],
          findById: (_id: string) => null,
          create: (_dto: CreateUserDto) => ({}),
        },
      }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
```

### Setu-TS

```typescript
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp, inject } from '@setu-ts/testing';

describe('Users', () => {
  it('GET /users', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/users', async (ctx) => {
      return ctx.response.json([{ id: 1, name: 'John' }]);
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/users',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual([{ id: 1, name: 'John' }]);
  });
});
```

## Common Patterns

### Request-Scoped Services

**There is no automatic equivalent, and `scope: 'scoped'` is not one.** This is the lifecycle
difference most likely to surprise a NestJS developer, so it is stated plainly rather than mapped.

### NestJS

```typescript
import { Injectable, Scope } from '@nestjs/common';

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {}
```

Nest instantiates this class once per request, automatically.

### Setu-TS

`ServiceScope`'s `'scoped'` means one instance per `IContainer.createScope()` scope, and **the
framework creates no scope per request** — so a `'scoped'` service is not re-created on every HTTP
request and behaves as a singleton until the application calls `createScope()` itself. Writing
`@Injectable({ scope: 'scoped' })` and expecting Nest's semantics gives you a shared instance with
no error and no warning.

An application that needs per-request instances creates and carries the scope itself:

```typescript
import { CAPABILITIES, type IContainer } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication();

app.middleware.add(async (ctx, next) => {
  const root = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
  ctx.state.set('app:request-scope', root.createScope());
  await next();
});
```

Handlers then resolve through that scope rather than through the root container.
[`apps/di-decorators`](https://github.com/setu-ts/setu-ts/tree/main/apps/di-decorators) serves a
`/lifetimes` route that makes the three lifetimes visible across two explicit scopes.

Note that the kernel _does_ give each request a child **service registry** (`ctx.services`), which
is a different thing: it scopes capability registrations, not DI container lifetimes.

### Middleware Order

### NestJS

```typescript
app.use(loggerMiddleware);
app.use(cors());
```

### Setu-TS

```typescript
// Middleware runs in priority order (lower first)
app.middleware.add(loggerMiddleware); // Default priority: 500
app.middleware.add(myMiddleware, { priority: 25 }); // Runs before default
```

## Migration Checklist

- [ ] Replace `@nestjs/*` imports with `@setu-ts/*`
- [ ] Replace `@Injectable()` with `@Injectable()` from `@setu-ts/decorator-plugin`
- [ ] Replace `@Controller()` with programmatic routes or `@Controller()` + `DecoratorPlugin`
- [ ] Replace constructor injection with `@Inject('token')` from `@setu-ts/decorator-plugin`
- [ ] Replace modules with plugin factories
- [ ] Replace TypeORM with Prisma/Drizzle or other supported ORM
- [ ] Replace `ConfigModule` with `ConfigPlugin`
- [ ] Replace `CacheModule` with `CachePlugin`
- [ ] Replace `@WebSocketGateway` with `WebSocketPlugin`
- [ ] Update testing utilities to use `createTestApp` and `inject`
- [ ] Update deployment configuration for target runtime

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Examples](./examples.md) - See real-world applications

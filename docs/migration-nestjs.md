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
import { Controller, Get } from '@nestjs/common';

@Controller()
class AppController {
  @Get()
  hello() {
    return { message: 'Hello' };
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
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
@Controller('users')
export class UsersController {
  @Get()
  findAll() {
    return this.userService.findAll();
  }

  @Get(':id')
  @Params(Param('id'))
  findOne(id: string) {
    return this.userService.findById(id);
  }

  @Post()
  @Params(Body())
  create(dto: CreateUserDto) {
    return this.userService.create(dto);
  }
}
```

### Setu-TS (Programmatic)

```typescript
app.router.get('/users', async (ctx) => {
  const userService = ctx.services.get<UserService>('userService');
  return ctx.response.json(await userService.findAll());
});

app.router.get('/users/:id', async (ctx) => {
  const userService = ctx.services.get<UserService>('userService');
  const id = ctx.params.id;
  return ctx.response.json(await userService.findById(id));
});

app.router.post('/users', async (ctx) => {
  const userService = ctx.services.get<UserService>('userService');
  const dto = await ctx.request.json();
  return ctx.response.status(201).json(await userService.create(dto));
});
```

### Setu-TS (With Decorators)

```typescript
import { Body, Controller, Get, Inject, Param, Params, Post } from '@setu-ts/decorator-plugin';

@Controller('/users')
@Inject('UserService')
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
@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private readonly userRepository: Repository<User>) {}
}
```

### Setu-TS

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';

@Injectable({ token: 'UserService' })
@Inject('UserRepository')
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}
}

// Register the service with the DecoratorPlugin, or programmatically:
ctx.services.register('UserService', new UserService(userRepository));
```

## Modules vs Plugins

### NestJS

```typescript
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
// Create a plugin factory
export function UsersPlugin(): IPlugin {
  return {
    name: 'users',
    version: '1.0.0',
    dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.DATABASE],
    async register(ctx) {
      // Register services
      ctx.services.register('UserService', new UserService());

      // Register routes directly
      ctx.router.get('/users', async (requestCtx) => {
        const userService = requestCtx.services.get<UserService>('UserService');
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
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    return !!token;
  }
}
```

### Setu-TS

```typescript
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
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
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
export const transformMiddleware: MiddlewareFunction = async (ctx, next) => {
  await next();

  // Transform response
  const snapshot = ctx.response.snapshot();
  if (!snapshot.streaming && snapshot.body) {
    const data = JSON.parse(snapshot.body as string);
    const transformed = { success: true, data };
    return ctx.response.json(transformed);
  }
};
```

## Exception Filters

### NestJS

```typescript
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
export const errorMiddleware: MiddlewareFunction = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof HttpException) {
      return ctx.response.status(error.status).json(
        {
          statusCode: error.status,
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
@Post()
@UsePipes(new ValidationPipe())
@Params(Body())
async create(createDto: CreateCatDto) {
  // dto is validated
}
```

### Setu-TS

```typescript
import { validateBody } from '@setu-ts/validation-plugin';

app.router.post('/users', {
  middleware: [validateBody(CreateUserDto)],
  handler: async (ctx) => {
    const dto = await ctx.request.json();
    // dto is validated
    return ctx.response.json({ created: dto });
  },
});
```

## Configuration

### NestJS

```typescript
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
constructor(@InjectConfig() private readonly config: ConfigService) {}
```

### Setu-TS

```typescript
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
import { DatabasePlugin } from '@setu-ts/database-plugin';

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
@Injectable()
@CacheTTL(300)
export class UserService {
  async findAll() {
    // Result cached for 300 seconds
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
import type { ICacheStore } from '@setu-ts/common';
const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
const users: unknown[] = [];
await cache.set('users:all', users, 300);
const cachedUsers = await cache.get<unknown[]>('users:all');
await cache.delete('users:all');
```

## Validation

### NestJS

```typescript
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
import { z } from '@std/zod';

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
    return ctx.response.status(400).json({ errors: result.error.errors });
  }
  const dto = result.data;
  return ctx.response.status(201).json({ created: dto });
});
```

## WebSocket

### NestJS

```typescript
@WebSocketGateway()
export class EventsGateway {
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
describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [UsersController],
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

### NestJS

```typescript
@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {}
```

### Setu-TS

```typescript
import { Injectable } from '@setu-ts/decorator-plugin';

@Injectable({ scope: 'scoped' })
export class RequestScopedService {}
```

### Middleware Order

### NestJS

```typescript
app.use(loggerMiddleware);
app.use(cors());
app.use(app.getHttpAdapter().getInstance());
```

### Setu-TS

```typescript
// Middleware runs in priority order (lower first)
app.middleware.add(loggerMiddleware); // Default priority: 500
app.middleware.add(loggerMiddleware, { priority: 25 }); // Runs before default
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

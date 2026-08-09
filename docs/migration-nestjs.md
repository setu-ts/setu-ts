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
| **Dependency Injection** | Automatic via reflection    | Explicit tokens (`@inject('token')`)      |
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
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { Controller, Get, injectable } from '@setu-ts/decorator-plugin';

@Controller()
@injectable()
class AppController {
  @Get()
  async hello() {
    return { message: 'Hello' };
  }
}

async function bootstrap() {
  const app = createApplication();

  app.register(RuntimePlugin());
  app.register(DiPlugin());
  app.register(DecoratorPlugin());

  // Register controllers manually or use discoverControllers
  // For decorators to work, register the controller instance
  app.register(MyController);

  await app.start({ port: 3000 });
}
bootstrap();
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
  return ctx.response.json(await userService.create(dto), { status: 201 });
});
```

### Setu-TS (With Decorators)

```typescript
import { Body, Controller, Get, injectable, Param, Post } from '@setu-ts/decorator-plugin';

@Controller('/users')
@injectable()
export class UsersController {
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

## Dependency Injection

### NestJS

```typescript
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {}
}
```

### Setu-TS

```typescript
import { inject, injectable } from '@setu-ts/di-plugin';

@injectable()
export class UserService {
  constructor(
    @inject('UserRepository') private readonly userRepository: UserRepository,
  ) {}
}

// Register the service
ctx.services.registerFactory(
  'UserService',
  () => ctx.services.get<IDiContainer>('container').create(UserService),
);
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
    dependencies: ['runtime', 'database'],
    async register(ctx) {
      // Register services
      ctx.services.registerFactory('UserService', () =>
        new UserService(
          ctx.services.get('userRepository'),
        ));

      // Register controllers (if using decorators)
      // Or register routes directly
      ctx.router.get('/users', async (ctx) => {
        const userService = ctx.services.get<UserService>('UserService');
        return ctx.response.json(await userService.findAll());
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
    return ctx.response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify token and set user
  const user = await verifyToken(token);
  ctx.state['user'] = user;

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
});
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
      return ctx.response.json(
        {
          statusCode: error.status,
          timestamp: new Date().toISOString(),
          path: ctx.request.path,
          message: error.message,
        },
        { status: error.status },
      );
    }

    // Log error
    ctx.logger?.error('Unhandled error', { error });

    return ctx.response.json(
      {
        statusCode: 500,
        message: 'Internal server error',
      },
      { status: 500 },
    );
  }
};
```

## Pipelines (Validation)

### NestJS

```typescript
@Post()
@UsePipes(new ValidationPipe())
async create(@Body() createDto: CreateCatDto) {
  // dto is validated
}
```

### Setu-TS

```typescript
import { validationMiddleware } from '@setu-ts/validation-plugin';

app.router.post(
  '/users',
  validationMiddleware(CreateUserDto),
  async (ctx) => {
    const dto = await ctx.request.json();
    // dto is validated
  },
);
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
  env: true,
  validate: {
    PORT: { type: 'number', default: 3000 },
    NODE_ENV: { type: 'string', enum: ['development', 'production'] },
  },
}));

// Usage
const config = ctx.config?.get('PORT');
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
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  async findAll() {
    return this.repo.find();
  }
}
```

### Setu-TS (Database Plugin)

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'prisma',
  prisma: {
    // Prisma client configuration
  },
}));

// Usage
const db = ctx.services.get<IDatabaseService>('database');
const users = await db.findAll('users');
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

app.register(CachePlugin({
  store: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
  },
}));

// Usage
const cache = ctx.services.get<ICacheService>('cache');
await cache.set('users:all', users, { ttl: 300 });
const users = await cache.get('users:all');
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
  validator: 'zod',
}));

// Or manual validation
app.router.post('/users', async (ctx) => {
  const result = CreateUserDto.safeParse(await ctx.request.json());
  if (!result.success) {
    return ctx.response.json({ errors: result.error.errors }, { status: 400 });
  }
  const dto = result.data;
  // ...
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
import { WebsocketPlugin } from '@setu-ts/websocket-plugin';

app.register(WebsocketPlugin({
  rooms: {
    '/ws': {
      onConnect: (ctx) => {
        console.log('Client connected');
      },
      onMessage: (ctx, message) => {
        ctx.room.broadcast({ type: 'message', data: message });
      },
    },
  },
}));
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
import { injectable, Scope } from '@setu-ts/di-plugin';

@injectable({ scope: Scope.REQUEST })
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
app.middleware.add(corsMiddleware); // Default priority: 500
app.middleware.add(authMiddleware, { priority: 25 }); // Runs before default
```

## Migration Checklist

- [ ] Replace `@nestjs/*` imports with `@setu-ts/*`
- [ ] Replace `@Injectable()` with `@injectable()`
- [ ] Replace `@Controller()` with programmatic routes or `@Controller()` + `DecoratorPlugin`
- [ ] Replace constructor injection with `@inject('token')`
- [ ] Replace modules with plugin factories
- [ ] Replace TypeORM with Prisma/Drizzle or other supported ORM
- [ ] Replace `ConfigModule` with `ConfigPlugin`
- [ ] Replace `CacheModule` with `CachePlugin`
- [ ] Replace `@WebSocketGateway` with `WebsocketPlugin`
- [ ] Update testing utilities to use `createTestApp` and `inject`
- [ ] Update deployment configuration for target runtime

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Examples](./examples.md) - See real-world applications

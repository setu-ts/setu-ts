import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ClassProvider, IContainer, Provider, ProviderOptions } from '@hono-enterprise/common';

import {
  Body,
  Controller,
  createDecorator,
  Delete,
  Get,
  Head,
  Inject,
  Injectable,
  Options,
  Patch,
  Post,
  Put,
  UseGuards,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import type { RegisteredRoute } from '../fixtures/fake-context.ts';

const guardFn = (): void => {};

/** Extracts the RouteDefinition a plugin registered. */
function routeDef(route: RegisteredRoute['route']): {
  handler: (ctx: { response: { json: (b: unknown) => unknown } }) => unknown;
  middleware?: unknown[];
} {
  return route as {
    handler: (ctx: { response: { json: (b: unknown) => unknown } }) => unknown;
    middleware?: unknown[];
  };
}

/** A recording DI container. */
function recordingContainer(): {
  container: IContainer;
  registered: { token: string; provider: Provider<unknown>; options?: ProviderOptions }[];
} {
  const registered: { token: string; provider: Provider<unknown>; options?: ProviderOptions }[] =
    [];
  const instances = new Map<string, unknown>();
  const container: IContainer = {
    register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): void {
      const entry: { token: string; provider: Provider<unknown>; options?: ProviderOptions } = {
        token,
        provider: provider as Provider<unknown>,
      };
      if (options !== undefined) {
        entry.options = options;
      }
      registered.push(entry);
    },
    has(token: string): boolean {
      return registered.some((r) => r.token === token);
    },
    resolve<T>(token: string): T {
      const entry = registered.find((r) => r.token === token);
      if (entry === undefined) {
        throw new Error(`not registered: ${token}`);
      }
      if (!instances.has(token)) {
        const cp = entry.provider as ClassProvider<unknown>;
        instances.set(token, new cp.useClass());
      }
      return instances.get(token) as T;
    },
    createScope(): IContainer {
      return container;
    },
  };
  return { container, registered };
}

describe('DecoratorPlugin internal paths', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('does not re-register a service already in the container', async () => {
    @Injectable({ token: 'svc' })
    class Svc {
      run() {
        return 1;
      }
    }
    const { container, registered } = recordingContainer();
    // Pre-register the token so registerInContainer is a no-op.
    container.register('svc', { useValue: new Svc() });
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ services: [Svc] }).register(ctx);
    // Only the pre-registration; no new ClassProvider entry for 'svc'.
    expect(registered.filter((r) => r.token === 'svc')).toHaveLength(1);
  });

  it('does not re-register a service already in the registry (no container)', async () => {
    @Injectable({ token: 'svc' })
    class Svc {
      run() {
        return 1;
      }
    }
    const { ctx, services } = createFakeContext();
    // Pre-register so registerService short-circuits.
    ctx.services.register('svc', new Svc());
    await DecoratorPlugin({ services: [Svc] }).register(ctx);
    expect(services.get('svc')?.length).toBe(1);
  });

  it('instantiates a controller via the container when registered', async () => {
    @Controller('/x')
    @Injectable({ token: 'ctrl' })
    class C {
      @Get('/')
      list() {
        return 'ok';
      }
    }
    const { container } = recordingContainer();
    container.register('ctrl', { useClass: C });
    const { ctx, routes } = createFakeContext({ container });
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(routes).toHaveLength(1);
  });

  it('instantiates a service with constructor injection from the registry', async () => {
    @Injectable({ token: 'repo' })
    @Inject('database')
    class Repo {
      db: unknown;
      constructor(db: unknown = null) {
        this.db = db;
      }
    }
    const { ctx, services } = createFakeContext();
    const db = { name: 'db' };
    ctx.services.register('database', db);
    await DecoratorPlugin({ services: [Repo] }).register(ctx);
    const repo = services.get('repo')?.[0] as { db: unknown };
    expect(repo.db).toBe(db);
  });

  it('throws when a handler method is missing on the instance', async () => {
    @Controller('/x')
    class C {
      // No method named 'list' on the instance at runtime — we'll fake it by
      // registering a route binding for a non-existent method.
      @Get('/')
      list() {
        return [];
      }
    }
    // Sabotage: remove the method from the prototype so createHandler throws.
    delete (C.prototype as { list?: () => unknown }).list;
    const { ctx } = createFakeContext();
    await expect(DecoratorPlugin({ controllers: [C] }).register(ctx))
      .rejects.toThrow();
  });

  it('serializes a handler return value as JSON', async () => {
    @Controller('/x')
    class C {
      @Get('/')
      list() {
        return { ok: true };
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const def = routeDef(routes[0].route);
    const calls: unknown[] = [];
    await def.handler({ response: { json: (b: unknown) => (calls.push(b), null) } });
    expect(calls).toEqual([{ ok: true }]);
  });

  it('does not replay custom decorators when no handlers are registered', async () => {
    @Controller('/x')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    // Add a custom decorator record but register no handler for it.
    metadataStore.addCustomDecorator({
      name: 'unhandled',
      metadata: {},
      target: C,
      propertyKey: 'list',
    });
    const { ctx } = createFakeContext();
    // Should not throw — the record is silently skipped.
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(ctx.services.has(CAPABILITIES.DECORATOR_HANDLER)).toBe(false);
  });

  it('skips a controller with no controller metadata', async () => {
    class Bare {
      hello() {
        return 'hi';
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [Bare] }).register(ctx);
    expect(routes).toEqual([]);
  });

  it('builds a route with middleware but no schema', async () => {
    @Controller('/x')
    class C {
      @Get('/')
      @UseGuards(guardFn)
      list() {
        return [];
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const def = routeDef(routes[0].route);
    expect(def.middleware).toHaveLength(1);
  });

  it('handler returning a HandlerResult is passed through', async () => {
    @Controller('/x')
    class C {
      @Get('/')
      list() {
        return { __handlerResult: true };
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const def = routeDef(routes[0].route);
    const result = await def.handler({ response: { json: () => null } });
    expect(result).toEqual({ __handlerResult: true });
  });

  it('resolves @Body parameter through the handler wrapper', async () => {
    @Controller('/x')
    class C {
      @Post('/')
      create(@Body() body: unknown) {
        return body;
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const def = routeDef(routes[0].route);
    const calls: unknown[] = [];
    await def.handler(
      {
        response: { json: (b: unknown) => (calls.push(b), null) },
        request: { json: () => Promise.resolve({ name: 'Alice' }) },
      } as unknown as Parameters<typeof def.handler>[0],
    );
    expect(calls).toEqual([{ name: 'Alice' }]);
  });

  it('registers PUT, PATCH, DELETE, HEAD, and OPTIONS routes', async () => {
    @Controller('/x')
    class C {
      @Put('/u')
      put() {
        return 'u';
      }
      @Patch('/pa')
      patch() {
        return 'pa';
      }
      @Delete('/d')
      del() {
        return 'd';
      }
      @Head('/h')
      head() {
        return 'h';
      }
      @Options('/o')
      opts() {
        return 'o';
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(routes.map((r) => r.method).sort()).toEqual(
      ['DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'PUT'],
    );
  });

  it('replays a class-level custom decorator (no propertyKey)', async () => {
    const seen: { target: object; propertyKey?: string }[] = [];
    @Controller('/x')
    @createDecorator('meta:class-level', { flag: true })
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    const { ctx } = createFakeContext();
    ctx.decorators.register('meta:class-level', (_metadata, target, propertyKey) => {
      const entry: { target: object; propertyKey?: string } = { target };
      if (propertyKey !== undefined) {
        entry.propertyKey = propertyKey;
      }
      seen.push(entry);
    });
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].propertyKey).toBeUndefined();
  });

  it('uses the class name as the service token when none is declared', async () => {
    @Injectable()
    class MyService {
      run() {
        return 1;
      }
    }
    const { ctx, services } = createFakeContext();
    await DecoratorPlugin({ services: [MyService] }).register(ctx);
    expect(services.has('MyService')).toBe(true);
  });
});

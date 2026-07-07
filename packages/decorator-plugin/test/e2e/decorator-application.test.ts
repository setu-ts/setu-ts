import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HandlerResult,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  MiddlewareFunction,
} from '@hono-enterprise/common';

import { createApplication } from '@hono-enterprise/kernel';

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** Minimal runtime-provider plugin backed by the fake runtime. */
function testRuntimePlugin(): IPlugin {
  const runtime: IRuntimeServices = createFakeRuntime();
  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

describe('decorator-driven application (e2e)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('routes a GET request to a decorated handler and serializes the return value', async () => {
    @Controller('/users')
    class UserController {
      @Get('/')
      list() {
        return [{ id: '1', name: 'Alice' }];
      }
    }

    const app = createApplication({
      plugins: [testRuntimePlugin(), DecoratorPlugin({ controllers: [UserController] })],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/users' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: '1', name: 'Alice' }]);
    await app.stop();
  });

  it('resolves @Param from the matched route path', async () => {
    @Controller('/users')
    class UserController {
      @Get('/:id')
      getById(@Param('id') id: string) {
        return { id, name: 'Alice' };
      }
    }

    const app = createApplication({
      plugins: [testRuntimePlugin(), DecoratorPlugin({ controllers: [UserController] })],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/users/42' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '42', name: 'Alice' });
    await app.stop();
  });

  it('resolves @Body and @Query from the request', async () => {
    @Controller('/users')
    class UserController {
      @Post('/')
      create(@Body() body: { name: string }, @Query('source') source: string) {
        return { id: '2', name: body.name, source };
      }
    }

    const app = createApplication({
      plugins: [testRuntimePlugin(), DecoratorPlugin({ controllers: [UserController] })],
    });
    await app.start();
    const res = await app.inject({
      method: 'POST',
      url: 'http://localhost/users?source=api',
      body: { name: 'Bob' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '2', name: 'Bob', source: 'api' });
    await app.stop();
  });

  it('a guard that responds without next() short-circuits the handler', async () => {
    let handlerRan = false;
    const guard: MiddlewareFunction = (ctx) => {
      ctx.response.status(403).json({ error: 'forbidden' });
      // Deliberately does not call next().
      return { __handlerResult: true } as HandlerResult;
    };

    @Controller('/secure')
    class SecureController {
      @Get('/')
      @UseGuards(guard)
      secret() {
        handlerRan = true;
        return 'top-secret';
      }
    }

    const app = createApplication({
      plugins: [testRuntimePlugin(), DecoratorPlugin({ controllers: [SecureController] })],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/secure' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(handlerRan).toBe(false);
    await app.stop();
  });

  it('returns 404 for an unknown route', async () => {
    @Controller('/users')
    class UserController {
      @Get('/')
      list() {
        return [];
      }
    }

    const app = createApplication({
      plugins: [testRuntimePlugin(), DecoratorPlugin({ controllers: [UserController] })],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/unknown' });
    expect(res.statusCode).toBe(404);
    await app.stop();
  });

  it('multiple decorated controllers coexist', async () => {
    @Controller('/users')
    class UserController {
      @Get('/')
      list() {
        return 'users';
      }
    }
    @Controller('/orders')
    class OrderController {
      @Get('/')
      list() {
        return 'orders';
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        DecoratorPlugin({ controllers: [UserController, OrderController] }),
      ],
    });
    await app.start();
    const users = await app.inject({ method: 'GET', url: 'http://localhost/users' });
    const orders = await app.inject({ method: 'GET', url: 'http://localhost/orders' });
    expect(users.json()).toBe('users');
    expect(orders.json()).toBe('orders');
    await app.stop();
  });
});

/**
 * Integration tests for CqrsPlugin via kernel app.inject().
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  ICommandBus,
  ICqrsFacade,
  IPlugin,
  IQueryBus,
  TimerHandle,
} from '@hono-enterprise/common';

/** Fake runtime plugin for integration tests. */
function fakeRuntimePlugin(): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      // Create a minimal fake runtime
      let uuidCounter = 0;
      const runtime = {
        platform: () => 'deno' as const,
        version: () => 'test',
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => {
          const id = globalThis.setTimeout(fn, ms);
          return { id } as TimerHandle;
        },
        clearTimeout: (handle: TimerHandle) =>
          globalThis.clearTimeout((handle as { id: number }).id),
        setInterval: (fn: () => void, ms: number) => {
          const id = globalThis.setInterval(fn, ms);
          return { id } as TimerHandle;
        },
        clearInterval: (handle: TimerHandle) =>
          globalThis.clearInterval((handle as { id: number }).id),
        uuid: () => `fake-${uuidCounter++}`,
        randomBytes: (length: number) => new Uint8Array(length),
        subtle: {} as SubtleCrypto,
        env: {},
        exit: () => {
          throw new Error('exit called');
        },
        hostname: () => 'localhost',
      };
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

interface TestCommand {
  type: string;
  data: { value: string };
}

interface TestQuery {
  type: string;
  data: { id: string };
}

describe('CqrsPlugin integration', () => {
  it('should execute command through the bus in a route handler', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), CqrsPlugin()],
    });

    // Register a command handler
    app.register({
      name: 'command-handler',
      version: '1.0.0',
      dependencies: ['cqrs'],
      register(ctx) {
        const commandBus = ctx.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
        commandBus.register<TestCommand, string>('TestCommand', {
          handle: (command) => `handled: ${command.data.value}`,
        });
      },
    });

    // Route handler executes command
    app.router.post('/test', async (ctx) => {
      const commandBus = ctx.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
      const result = await commandBus.execute<string>({
        type: 'TestCommand',
        data: { value: 'test-data' },
      });
      return ctx.response.status(200).json({ result });
    });

    await app.start();
    const response = await app.inject({
      method: 'POST',
      url: 'http://localhost/test',
      headers: new Headers(),
      body: {},
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ result: string }>();
    expect(body.result).toBe('handled: test-data');
  });

  it('should execute query through the bus in a route handler', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), CqrsPlugin()],
    });

    // Register a query handler
    app.register({
      name: 'query-handler',
      version: '1.0.0',
      dependencies: ['cqrs'],
      register(ctx) {
        const queryBus = ctx.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
        queryBus.register<TestQuery, { id: string; name: string }>('TestQuery', {
          handle: (query) => ({ id: query.data.id, name: `User ${query.data.id}` }),
        });
      },
    });

    // Route handler executes query
    app.router.get('/users/:id', async (ctx) => {
      const queryBus = ctx.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
      const user = await queryBus.execute<{ id: string; name: string }>({
        type: 'TestQuery',
        data: { id: ctx.params.id },
      });
      return ctx.response.json(user);
    });

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/users/123',
      headers: new Headers(),
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ id: string; name: string }>();
    expect(body.id).toBe('123');
    expect(body.name).toBe('User 123');
  });

  it('should expose CQRS facade with both buses', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), CqrsPlugin()],
    });

    // Route handler accesses facade
    app.router.get('/facade', (ctx) => {
      const facade = ctx.services.get<ICqrsFacade>(CAPABILITIES.CQRS);
      return ctx.response.json({
        hasCommandBus: !!facade.commandBus,
        hasQueryBus: !!facade.queryBus,
      });
    });

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/facade',
      headers: new Headers(),
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ hasCommandBus: boolean; hasQueryBus: boolean }>();
    expect(body.hasCommandBus).toBe(true);
    expect(body.hasQueryBus).toBe(true);
  });

  it('should work with custom behaviors', async () => {
    const calls: string[] = [];

    const trackingBehavior = {
      handle: async (_req: unknown, next: () => Promise<unknown>) => {
        calls.push('before');
        const result = await next();
        calls.push('after');
        return result;
      },
    };

    const app = createApplication({
      plugins: [fakeRuntimePlugin(), CqrsPlugin({ behaviors: [trackingBehavior] })],
    });

    // Register a command handler
    app.register({
      name: 'command-handler',
      version: '1.0.0',
      dependencies: ['cqrs'],
      register(ctx) {
        const commandBus = ctx.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
        commandBus.register<TestCommand, string>('TestCommand', {
          handle: (command) => {
            calls.push('handler');
            return `handled: ${command.data.value}`;
          },
        });
      },
    });

    // Route handler executes command
    app.router.post('/test', async (ctx) => {
      const commandBus = ctx.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
      const result = await commandBus.execute<string>({
        type: 'TestCommand',
        data: { value: 'test' },
      });
      return ctx.response.json({ result });
    });

    await app.start();
    const response = await app.inject({
      method: 'POST',
      url: 'http://localhost/test',
      headers: new Headers(),
      body: {},
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(['before', 'handler', 'after']);
  });
});

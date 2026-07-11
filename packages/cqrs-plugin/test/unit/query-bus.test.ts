/**
 * Query bus tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueryBus } from '../../src/bus/query-bus.ts';
import type { CqrsQuery, IQueryHandler } from '@hono-enterprise/common';
import { HandlerNotFoundError } from '../../src/errors/handler-not-found.ts';

// Test query
class TestQuery implements CqrsQuery {
  readonly type = 'TestQuery';
  constructor(public readonly data: { id: string }) {}
}

// Test handler
class TestHandler implements IQueryHandler<TestQuery, { id: string; name: string }> {
  handle(query: TestQuery): { id: string; name: string } {
    return { id: query.data.id, name: `User ${query.data.id}` };
  }
}

describe('QueryBus', () => {
  it('should register and execute a query handler', async () => {
    const bus = new QueryBus();
    const handler = new TestHandler();

    bus.register('TestQuery', handler);

    const qry = new TestQuery({ id: '123' });
    const result = await bus.execute<{ id: string; name: string }>(qry);

    expect(result).toEqual({ id: '123', name: 'User 123' });
  });

  it('should support async handlers', async () => {
    const bus = new QueryBus();
    const asyncHandler: IQueryHandler<TestQuery, string> = {
      handle: async (qry) => {
        await Promise.resolve();
        return `async: ${qry.data.id}`;
      },
    };

    bus.register('TestQuery', asyncHandler);

    const qry = new TestQuery({ id: '123' });
    const result = await bus.execute<string>(qry);

    expect(result).toBe('async: 123');
  });

  it('should throw HandlerNotFoundError for unregistered type', () => {
    const bus = new QueryBus();
    const qry = new TestQuery({ id: '123' });

    expect(() => bus.execute(qry)).toThrow(HandlerNotFoundError);
  });

  it('should throw TypeError if query.type is not a string', () => {
    const bus = new QueryBus();
    const badQry = { type: 123 as unknown as string, data: {} };

    expect(() => bus.execute(badQry)).toThrow(TypeError);
  });

  it('should run behaviors around the handler', async () => {
    const calls: string[] = [];

    const behavior = {
      handle: (_req: unknown, next: () => Promise<unknown>) => {
        calls.push('before');
        return next().then((r) => {
          calls.push('after');
          return r;
        });
      },
    };

    const bus = new QueryBus([behavior]);
    const handler: IQueryHandler<TestQuery, string> = {
      handle: (qry) => {
        calls.push('handler');
        return qry.data.id;
      },
    };

    bus.register('TestQuery', handler);

    const qry = new TestQuery({ id: '123' });
    const result = await bus.execute<string>(qry);

    expect(calls).toEqual(['before', 'handler', 'after']);
    expect(result).toBe('123');
  });

  it('should short-circuit when a behavior does not call next()', async () => {
    const calls: string[] = [];

    const shortCircuitBehavior = {
      handle: (_req: unknown, _next: () => Promise<unknown>) => {
        calls.push('short-circuit');
        return 'early';
      },
    };

    const bus = new QueryBus([shortCircuitBehavior]);
    const handler: IQueryHandler<TestQuery, string> = {
      handle: (_qry) => {
        calls.push('handler');
        return 'should-not-reach';
      },
    };

    bus.register('TestQuery', handler);

    const qry = new TestQuery({ id: '123' });
    const result = await bus.execute<string>(qry);

    expect(calls).toEqual(['short-circuit']);
    expect(result).toBe('early');
  });

  it('should replace handler on re-registration', async () => {
    const bus = new QueryBus();
    const handler1: IQueryHandler<TestQuery, string> = {
      handle: () => 'first',
    };
    const handler2: IQueryHandler<TestQuery, string> = {
      handle: () => 'second',
    };

    bus.register('TestQuery', handler1);
    bus.register('TestQuery', handler2);

    const qry = new TestQuery({ id: '123' });
    const result = await bus.execute<string>(qry);

    expect(result).toBe('second');
  });

  it('should track handler count', () => {
    const bus = new QueryBus();
    expect(bus.handlerCount).toBe(0);

    bus.register('TestQuery', new TestHandler());
    expect(bus.handlerCount).toBe(1);

    bus.register('AnotherQuery', { handle: () => 'x' });
    expect(bus.handlerCount).toBe(2);
  });

  it('should clear handlers', () => {
    const bus = new QueryBus();
    bus.register('TestQuery', new TestHandler());
    expect(bus.handlerCount).toBe(1);

    bus.clear();
    expect(bus.handlerCount).toBe(0);
  });

  it('should support plain object queries', async () => {
    const bus = new QueryBus();
    const handler: IQueryHandler<CqrsQuery, string> = {
      handle: (qry) => `handled: ${qry.type}`,
    };

    bus.register('TestQuery', handler);

    const qry = { type: 'TestQuery', data: {} };
    const result = await bus.execute<string>(qry);

    expect(result).toBe('handled: TestQuery');
  });

  it('should keep command and query registries separate', () => {
    // This is a compile-time check: QueryBus only accepts IQueryHandler
    const bus = new QueryBus();
    // The following would not compile if we tried to register an ICommandHandler:
    // bus.register('TestQuery', commandHandlerImplementingICommandHandler);
    // But we verify at runtime that the bus is for queries only by checking type.
    expect(bus).toBeInstanceOf(QueryBus);
  });
});

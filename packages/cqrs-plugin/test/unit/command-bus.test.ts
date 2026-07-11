/**
 * Command bus tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CommandBus } from '../../src/bus/command-bus.ts';
import type { CqrsCommand, ICommandHandler } from '@hono-enterprise/common';
import { HandlerNotFoundError } from '../../src/errors/handler-not-found.ts';

// Test command
class TestCommand implements CqrsCommand {
  readonly type = 'TestCommand';
  constructor(public readonly data: { value: string }) {}
}

// Test handler
class TestHandler implements ICommandHandler<TestCommand, string> {
  handle(command: TestCommand): string {
    return `handled: ${command.data.value}`;
  }
}

describe('CommandBus', () => {
  it('should register and execute a command handler', async () => {
    const bus = new CommandBus();
    const handler = new TestHandler();

    bus.register('TestCommand', handler);

    const cmd = new TestCommand({ value: 'test' });
    const result = await bus.execute<string>(cmd);

    expect(result).toBe('handled: test');
  });

  it('should support async handlers', async () => {
    const bus = new CommandBus();
    const asyncHandler: ICommandHandler<TestCommand, string> = {
      handle: async (cmd) => {
        await Promise.resolve();
        return `async: ${cmd.data.value}`;
      },
    };

    bus.register('TestCommand', asyncHandler);

    const cmd = new TestCommand({ value: 'test' });
    const result = await bus.execute<string>(cmd);

    expect(result).toBe('async: test');
  });

  it('should throw HandlerNotFoundError for unregistered type', () => {
    const bus = new CommandBus();
    const cmd = new TestCommand({ value: 'test' });

    expect(() => bus.execute(cmd)).toThrow(HandlerNotFoundError);
  });

  it('should throw TypeError if command.type is not a string', () => {
    const bus = new CommandBus();
    const badCmd = { type: 123 as unknown as string, data: {} };

    expect(() => bus.execute(badCmd)).toThrow(TypeError);
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

    const bus = new CommandBus([behavior]);
    const handler: ICommandHandler<TestCommand, string> = {
      handle: (cmd) => {
        calls.push('handler');
        return cmd.data.value;
      },
    };

    bus.register('TestCommand', handler);

    const cmd = new TestCommand({ value: 'test' });
    const result = await bus.execute<string>(cmd);

    expect(calls).toEqual(['before', 'handler', 'after']);
    expect(result).toBe('test');
  });

  it('should short-circuit when a behavior does not call next()', async () => {
    const calls: string[] = [];

    const shortCircuitBehavior = {
      handle: (_req: unknown, _next: () => Promise<unknown>) => {
        calls.push('short-circuit');
        return 'early';
      },
    };

    const bus = new CommandBus([shortCircuitBehavior]);
    const handler: ICommandHandler<TestCommand, string> = {
      handle: (_cmd) => {
        calls.push('handler');
        return 'should-not-reach';
      },
    };

    bus.register('TestCommand', handler);

    const cmd = new TestCommand({ value: 'test' });
    const result = await bus.execute<string>(cmd);

    expect(calls).toEqual(['short-circuit']);
    expect(result).toBe('early');
  });

  it('should replace handler on re-registration', async () => {
    const bus = new CommandBus();
    const handler1: ICommandHandler<TestCommand, string> = {
      handle: () => 'first',
    };
    const handler2: ICommandHandler<TestCommand, string> = {
      handle: () => 'second',
    };

    bus.register('TestCommand', handler1);
    bus.register('TestCommand', handler2);

    const cmd = new TestCommand({ value: 'test' });
    const result = await bus.execute<string>(cmd);

    expect(result).toBe('second');
  });

  it('should track handler count', () => {
    const bus = new CommandBus();
    expect(bus.handlerCount).toBe(0);

    bus.register('TestCommand', new TestHandler());
    expect(bus.handlerCount).toBe(1);

    bus.register('AnotherCommand', { handle: () => 'x' });
    expect(bus.handlerCount).toBe(2);
  });

  it('should clear handlers', () => {
    const bus = new CommandBus();
    bus.register('TestCommand', new TestHandler());
    expect(bus.handlerCount).toBe(1);

    bus.clear();
    expect(bus.handlerCount).toBe(0);
  });

  it('should support plain object commands', async () => {
    const bus = new CommandBus();
    const handler: ICommandHandler<CqrsCommand, string> = {
      handle: (cmd) => `handled: ${cmd.type}`,
    };

    bus.register('TestCommand', handler);

    const cmd = { type: 'TestCommand', data: {} };
    const result = await bus.execute<string>(cmd);

    expect(result).toBe('handled: TestCommand');
  });
});

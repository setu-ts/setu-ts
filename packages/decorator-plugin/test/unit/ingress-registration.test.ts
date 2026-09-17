import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IJob,
  IQueue,
  IScheduler,
  IWebSocketConnection,
  IWebSocketService,
  ProcessOptions,
  ScheduleOptions,
  WebSocketHandlers,
} from '@setu-ts/common';

import {
  Cron,
  Every,
  Gateway,
  OnClose,
  OnEvent,
  OnMessage,
  OnOpen,
  Processor,
  UseIngressBehaviors,
  UsePipelineBehaviors,
} from '../../src/decorators/ingress.ts';
import { UseGuards } from '../../src/decorators/pipeline.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

interface RecordedProcessor {
  readonly name: string;
  readonly processor: unknown;
  readonly options: ProcessOptions | undefined;
}

function queueDouble(recorded: RecordedProcessor[]): IQueue {
  return {
    add: () => Promise.resolve('job-id'),
    addRecurring: async () => {},
    process(name, processor, options): void {
      recorded.push({ name, processor, options });
    },
  };
}

interface RecordedSchedule {
  readonly name: string;
  readonly value: string | number;
  readonly invoke: (job: unknown) => Promise<void>;
  readonly options: ScheduleOptions | undefined;
}

function schedulerDouble(recorded: RecordedSchedule[]): IScheduler {
  return {
    cron(name, expression, handler, options): Promise<void> {
      recorded.push({
        name,
        value: expression,
        invoke: async (job) => await handler(job as never),
        options,
      });
      return Promise.resolve();
    },
    every(name, intervalMs, handler, options): Promise<void> {
      recorded.push({
        name,
        value: intervalMs,
        invoke: async (job) => await handler(job as never),
        options,
      });
      return Promise.resolve();
    },
    delay: async () => {},
    pause: async () => {},
    resume: async () => {},
    remove: async () => {},
    getNextRun: () => Promise.resolve(0),
  };
}

interface RecordedGateway {
  readonly path: string;
  readonly handlers: WebSocketHandlers;
}

function websocketDouble(recorded: RecordedGateway[]): IWebSocketService {
  return {
    available: true,
    connectionCount: 0,
    roomCount: 0,
    route(path, handlers): void {
      recorded.push({ path, handlers });
    },
    room() {
      return {
        name: 'test',
        size: 0,
        add() {},
        remove() {},
        broadcast() {},
        broadcastJson() {},
      };
    },
    peek() {
      return undefined;
    },
  };
}

function websocketConnection(): IWebSocketConnection {
  return {
    id: 'connection-1',
    path: '/notifications',
    readyState: 'open',
    isOpen: true,
    data: new Map(),
    send() {},
    sendJson() {},
    close() {},
  };
}

describe('non-HTTP ingress registration', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('keeps the no-ingress plugin shape unchanged', async () => {
    const { ctx, lifecycleHooks } = createFakeContext();
    const plugin = DecoratorPlugin();
    expect(plugin.optionalDependencies).toEqual([
      CAPABILITIES.VALIDATION,
      CAPABILITIES.AUTHORIZATION,
      CAPABILITIES.VIEW,
    ]);
    await plugin.register(ctx);
    expect(lifecycleHooks.some((hook) => hook.phase === 'onInit')).toBe(false);
  });

  it('registers a decorated queue processor during onInit and binds its class instance', async () => {
    const calls: string[] = [];
    class Jobs {
      @Processor('email', { concurrency: 2 })
      process(job: IJob<{ readonly id: string }>): void {
        calls.push(job.data.id);
      }
    }

    const recorded: RecordedProcessor[] = [];
    const { ctx, lifecycleHooks } = createFakeContext();
    ctx.services.register(CAPABILITIES.QUEUE, queueDouble(recorded));
    await DecoratorPlugin({ ingress: [Jobs] }).register(ctx);

    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    expect(hook).toBeDefined();
    await hook?.fn();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].name).toBe('email');
    expect(recorded[0].options).toEqual({ concurrency: 2 });
    const processor = recorded[0].processor;
    if (typeof processor !== 'function') throw new Error('Queue processor was not registered.');
    await processor({
      id: 'job-1',
      name: 'email',
      data: { id: 'message' },
      attempts: 1,
    });
    expect(calls).toEqual(['message']);
  });

  it('refuses a decorated processor when QueuePlugin is absent', async () => {
    class Jobs {
      @Processor('email')
      process(): void {}
    }

    const { ctx, lifecycleHooks } = createFakeContext();
    await DecoratorPlugin({ ingress: [Jobs] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await expect(hook?.fn()).rejects.toThrow(/Jobs\.process.*QueuePlugin/);
  });

  it('scopes ingress behavior to the decorated processor', async () => {
    let handlerRan = false;
    class Jobs {
      @Processor('email')
      @UseIngressBehaviors({ handle: () => {} })
      process(): void {
        handlerRan = true;
      }
    }

    const recorded: RecordedProcessor[] = [];
    const { ctx, lifecycleHooks } = createFakeContext();
    ctx.services.register(CAPABILITIES.QUEUE, queueDouble(recorded));
    await DecoratorPlugin({ ingress: [Jobs] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await hook?.fn();
    const processor = recorded[0].processor;
    if (typeof processor !== 'function') throw new Error('Queue processor was not registered.');
    await processor({ id: 'job-1', name: 'email', data: {}, attempts: 1 });
    expect(handlerRan).toBe(false);
  });

  it('registers cron and interval handlers and preserves their options', async () => {
    const calls: string[] = [];
    class Jobs {
      @Cron('0 * * * *', { data: { source: 'cron' } })
      cron(job: IJob<{ readonly source: string }>): void {
        calls.push(job.data.source);
      }

      @Every(500, { data: { source: 'interval' } })
      every(job: IJob<{ readonly source: string }>): void {
        calls.push(job.data.source);
      }
    }

    const recorded: RecordedSchedule[] = [];
    const { ctx, lifecycleHooks } = createFakeContext();
    ctx.services.register(CAPABILITIES.SCHEDULER, schedulerDouble(recorded));
    await DecoratorPlugin({ ingress: [Jobs] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await hook?.fn();

    expect(recorded.map(({ name, value, options }) => ({ name, value, options }))).toEqual([
      { name: 'cron', value: '0 * * * *', options: { data: { source: 'cron' } } },
      { name: 'every', value: 500, options: { data: { source: 'interval' } } },
    ]);
    await recorded[0].invoke({
      id: 'cron-1',
      name: 'cron',
      data: { source: 'cron' },
      attempts: 1,
    });
    await recorded[1].invoke({
      id: 'every-1',
      name: 'every',
      data: { source: 'interval' },
      attempts: 1,
    });
    expect(calls).toEqual(['cron', 'interval']);
  });

  it('registers gateway lifecycle methods and invokes each bound method', async () => {
    const calls: string[] = [];
    @Gateway('/notifications')
    class Notifications {
      @OnOpen
      open(): void {
        calls.push('open');
      }

      @OnMessage
      message(_connection: IWebSocketConnection, data: string | Uint8Array): void {
        calls.push(typeof data === 'string' ? data : 'binary');
      }

      @OnClose
      close(): void {
        calls.push('close');
      }
    }

    const recorded: RecordedGateway[] = [];
    const { ctx, lifecycleHooks } = createFakeContext();
    ctx.services.register(CAPABILITIES.WEBSOCKET, websocketDouble(recorded));
    await DecoratorPlugin({ ingress: [Notifications] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await hook?.fn();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].path).toBe('/notifications');
    const connection = websocketConnection();
    await recorded[0].handlers.onOpen?.(connection, {
      url: 'http://example.test/notifications',
      path: '/notifications',
      query: {},
      headers: new Headers(),
    });
    await recorded[0].handlers.onMessage?.(connection, 'notice');
    await recorded[0].handlers.onClose?.(connection, { code: 1000, reason: '' });
    expect(calls).toEqual(['open', 'notice', 'close']);
  });

  it('rejects an orphan gateway handler before resolving WebSocketPlugin', async () => {
    class OrphanedGateway {
      @OnOpen
      open(): void {}
    }

    const { ctx, lifecycleHooks } = createFakeContext();
    await DecoratorPlugin({ ingress: [OrphanedGateway] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await expect(hook?.fn()).rejects.toThrow(/WebSocket handlers but no @Gateway/);
  });

  it('refuses behavior decorators that do not match their handler category', async () => {
    class InvalidIngressBehavior {
      @Processor('email')
      @UsePipelineBehaviors({ handle: async (_request, next) => await next() })
      process(): void {}
    }

    class InvalidPipelineBehavior {
      @OnEvent('audit.recorded')
      @UseIngressBehaviors({ handle: async (_context, next) => await next() })
      process(): void {}
    }

    const first = createFakeContext();
    first.ctx.services.register(CAPABILITIES.QUEUE, queueDouble([]));
    await DecoratorPlugin({ ingress: [InvalidIngressBehavior] }).register(first.ctx);
    const firstHook = first.lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await expect(firstHook?.fn()).rejects.toThrow(/UsePipelineBehaviors.*not a command or query/);

    const second = createFakeContext();
    await DecoratorPlugin({ ingress: [InvalidPipelineBehavior] }).register(second.ctx);
    const secondHook = second.lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await expect(secondHook?.fn()).rejects.toThrow(/UseIngressBehaviors.*does not support/);
  });

  it('refuses @UseGuards on an ingress handler instead of silently ignoring it', async () => {
    class Jobs {
      @Processor('email')
      @UseGuards(async (_ctx, next) => await next())
      process(): void {}
    }

    const { ctx, lifecycleHooks } = createFakeContext();
    ctx.services.register(CAPABILITIES.QUEUE, queueDouble([]));
    await DecoratorPlugin({ ingress: [Jobs] }).register(ctx);
    const hook = lifecycleHooks.find((candidate) => candidate.phase === 'onInit');
    await expect(hook?.fn()).rejects.toThrow(/Jobs\.process.*UseGuards.*non-HTTP ingress/);
  });
});

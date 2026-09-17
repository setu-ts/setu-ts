import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  ICommandBus,
  IEventBus,
  IMessageBroker,
  IQueryBus,
  IQueue,
  IScheduler,
} from '@setu-ts/common';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { EventsPlugin } from '@setu-ts/events-plugin';
import { createApplication } from '@setu-ts/kernel';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';

import {
  CommandHandler,
  Cron,
  Every,
  OnEvent,
  Processor,
  QueryHandler,
  Subscribe,
  UseIngressBehaviors,
  UsePipelineBehaviors,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

async function until(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

describe('decorated non-HTTP ingress through real plugins', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('delivers a real domain event to an @OnEvent method', async () => {
    const received: string[] = [];
    class EventHandlers {
      @OnEvent('user.created')
      handle(event: { readonly data: { readonly id: string } }): void {
        received.push(event.data.id);
      }
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), EventsPlugin(), DecoratorPlugin({ ingress: [EventHandlers] })],
    });
    await app.start();
    const events = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
    await events.publish({
      type: 'user.created',
      id: 'event-1',
      occurredOn: new Date(0),
      data: { id: 'user-1' },
    });
    expect(received).toEqual(['user-1']);
    await app.stop();
  });

  it('registers decorated command and query methods through real buses', async () => {
    const phases: string[] = [];
    class Requests {
      @CommandHandler('create-user')
      @UsePipelineBehaviors({
        handle: async (_request, next) => {
          phases.push('before');
          const result = await next();
          phases.push('after');
          return result;
        },
      })
      command(request: { readonly data: { readonly id: string } }): { readonly id: string } {
        phases.push('command');
        return { id: request.data.id };
      }

      @QueryHandler('find-user')
      query(request: { readonly data: { readonly id: string } }): { readonly id: string } {
        return { id: request.data.id };
      }
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), CqrsPlugin(), DecoratorPlugin({ ingress: [Requests] })],
    });
    await app.start();
    const commands = app.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
    const queries = app.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
    await expect(commands.execute({ type: 'create-user', data: { id: 'user-1' } })).resolves
      .toEqual({
        id: 'user-1',
      });
    await expect(queries.execute({ type: 'find-user', data: { id: 'user-2' } })).resolves.toEqual({
      id: 'user-2',
    });
    expect(phases).toEqual(['before', 'command', 'after']);
    await app.stop();
  });

  it('delivers a real broker message to a @Subscribe method', async () => {
    const received: string[] = [];
    class Subscribers {
      @Subscribe('user.created')
      handle(message: { readonly id: string }): void {
        received.push(message.id);
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin(),
        DecoratorPlugin({ ingress: [Subscribers] }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await broker.publish('user.created', { id: 'user-1' });
    await Promise.resolve();
    expect(received).toEqual(['user-1']);
    await app.stop();
  });

  it('delivers a real memory-queue job to an @Processor method', async () => {
    const received: string[] = [];
    class Jobs {
      @Processor('email')
      process(job: { readonly data: { readonly id: string } }): void {
        received.push(job.data.id);
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({ adapter: 'memory', pollIntervalMs: 5 }),
        DecoratorPlugin({ ingress: [Jobs] }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('email', { id: 'message-1' });
    await until(() => received.length === 1, 'the decorated queue processor');
    expect(received).toEqual(['message-1']);
    await app.stop();
  });

  it('scopes a short-circuiting ingress behavior to its decorated processor', async () => {
    const phases: string[] = [];
    class Jobs {
      @Processor('email')
      @UseIngressBehaviors({
        handle: () => {
          phases.push('behavior');
        },
      })
      process(): void {
        phases.push('handler');
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({ adapter: 'memory', pollIntervalMs: 5 }),
        DecoratorPlugin({ ingress: [Jobs] }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('email', {});
    await until(() => phases.includes('behavior'), 'the processor behavior');
    expect(phases).toEqual(['behavior']);
    await app.stop();
  });

  it('delivers real scheduler work to @Cron and @Every methods', async () => {
    const received: string[] = [];
    class Jobs {
      @Cron('* * * * *')
      cron(): void {
        received.push('cron');
      }

      @Every(5)
      every(): void {
        received.push('every');
      }
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), SchedulerPlugin(), DecoratorPlugin({ ingress: [Jobs] })],
    });
    await app.start();
    const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
    expect(await scheduler.getNextRun('cron')).toBeGreaterThan(0);
    await until(() => received.includes('every'), 'the decorated interval job');
    expect(received).toContain('every');
    await app.stop();
  });

  it('round-trips a real WebSocket frame through a decorated gateway', async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-net',
        '--allow-read',
        '--allow-import',
        '--allow-env',
        '--allow-sys=hostname,osRelease',
        '--allow-write',
        'packages/decorator-plugin/test/fixtures/ingress-websocket-probe.ts',
      ],
    }).output();
    expect(result.code, new TextDecoder().decode(result.stderr)).toBe(0);
  });
});

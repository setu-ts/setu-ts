import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIngressBehavior, IPipelineBehavior } from '@setu-ts/common';

import {
  CommandHandler,
  Cron,
  Every,
  Gateway,
  OnClose,
  OnEvent,
  OnMessage,
  OnOpen,
  Processor,
  QueryHandler,
  Subscribe,
  UseIngressBehaviors,
  UsePipelineBehaviors,
} from '../../src/decorators/ingress.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

const ingressBehavior: IIngressBehavior = { handle: async (_ctx, next) => await next() };
const pipelineBehavior: IPipelineBehavior = { handle: async (_request, next) => await next() };

describe('non-HTTP ingress decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('records queue, scheduler, event, and messaging handlers', () => {
    class Handlers {
      @Processor('email', { concurrency: 2 })
      process(): void {}

      @Cron('0 2 * * *', { data: { source: 'cron' } })
      cron(): void {}

      @Every(1_000)
      every(): void {}

      @OnEvent('user.created')
      event(): void {}

      @Subscribe('user.created', { queue: 'workers' })
      subscription(): void {}
    }

    expect(metadataStore.getIngress(Handlers)).toEqual([
      { kind: 'queue', handler: 'process', name: 'email', options: { concurrency: 2 } },
      {
        kind: 'scheduler-cron',
        handler: 'cron',
        expression: '0 2 * * *',
        options: { data: { source: 'cron' } },
      },
      { kind: 'scheduler-every', handler: 'every', intervalMs: 1_000 },
      { kind: 'event', handler: 'event', type: 'user.created' },
      {
        kind: 'messaging',
        handler: 'subscription',
        topic: 'user.created',
        options: { queue: 'workers' },
      },
    ]);
  });

  it('omits optional registration options when they are not supplied', () => {
    class Handlers {
      @Processor('email')
      process(): void {}

      @Cron('0 2 * * *')
      cron(): void {}

      @Every(1_000, { retry: { limit: 2, delay: 1, backoff: 'fixed' } })
      every(): void {}

      @Subscribe('user.created')
      subscription(): void {}
    }

    expect(metadataStore.getIngress(Handlers)).toEqual([
      { kind: 'queue', handler: 'process', name: 'email' },
      { kind: 'scheduler-cron', handler: 'cron', expression: '0 2 * * *' },
      {
        kind: 'scheduler-every',
        handler: 'every',
        intervalMs: 1_000,
        options: { retry: { limit: 2, delay: 1, backoff: 'fixed' } },
      },
      { kind: 'messaging', handler: 'subscription', topic: 'user.created' },
    ]);
  });

  it('drains member metadata when a gateway class decorator flushes it', () => {
    @Gateway('/ws/chat')
    class ChatGateway {
      @OnOpen
      open(): void {}

      @OnMessage
      message(): void {}

      @OnClose
      close(): void {}
    }

    expect(metadataStore.getIngress(ChatGateway)).toEqual([
      { kind: 'websocket-open', handler: 'open' },
      { kind: 'websocket-message', handler: 'message' },
      { kind: 'websocket-close', handler: 'close' },
      { kind: 'gateway', path: '/ws/chat' },
    ]);
  });

  it('records CQRS handler and typed behavior declarations', () => {
    class Requests {
      @CommandHandler('create-user')
      @UsePipelineBehaviors(pipelineBehavior)
      command(): void {}

      @QueryHandler('find-user')
      query(): void {}

      @Processor('email')
      @UseIngressBehaviors(ingressBehavior)
      processor(): void {}
    }

    expect(metadataStore.getIngress(Requests)).toEqual([
      { kind: 'pipeline-behaviors', handler: 'command', behaviors: [pipelineBehavior] },
      { kind: 'command', handler: 'command', type: 'create-user' },
      { kind: 'query', handler: 'query', type: 'find-user' },
      { kind: 'ingress-behaviors', handler: 'processor', behaviors: [ingressBehavior] },
      { kind: 'queue', handler: 'processor', name: 'email' },
    ]);
  });

  it('clears ingress declarations with the rest of the metadata store', () => {
    class Handler {
      @OnEvent('user.created')
      event(): void {}
    }
    expect(metadataStore.getIngress(Handler)).toHaveLength(1);
    metadataStore.clear();
    expect(metadataStore.getIngress(Handler)).toEqual([]);
  });
});

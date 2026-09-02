/**
 * Unit tests for the internal PipelinedBroker (M86 §3.8/§3.12).
 *
 * The decorator forwards every `MessageBrokerAdapter` member, composes the
 * behaviour chain ONLY inside `subscribe`/`subscribeWithHeaders` (the single
 * insertion point — the underlying broker is untouched), and forwards
 * `respond` UNWRAPPED, pinning the RPC deferral. Envelope assertions: the
 * messaging arm carries `kind: 'messaging'`, the topic, the message as
 * `payload`, and `MessageMetadata.headers` — and deliberately NO `attempt`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IngressContext,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import * as messaging from '../../src/index.ts';

/** Which subscribe entry point the underlying adapter was reached through. */
type SubscribeVia = 'subscribe' | 'subscribeWithHeaders';

interface RecordedSubscription {
  readonly topic: string;
  readonly handler: MessageHandler<unknown>;
  readonly options?: SubscribeOptions;
  readonly via: SubscribeVia;
}

interface RecordedResponse {
  readonly topic: string;
  readonly handler: RequestHandler<unknown, unknown>;
  readonly options?: SubscribeOptions;
}

interface FakeAdapter {
  readonly adapter: MessageBrokerAdapter;
  readonly log: string[];
  readonly connects: { connect: number; disconnect: number };
  readonly publishes: { topic: string; message: unknown }[];
  readonly publishesWithHeaders: {
    topic: string;
    message: unknown;
    headers: Readonly<Record<string, string>>;
  }[];
  readonly requests: { topic: string; message: unknown; options?: RequestOptions }[];
  readonly requestsWithHeaders: {
    topic: string;
    message: unknown;
    headers: Readonly<Record<string, string>>;
    options?: RequestOptions;
  }[];
  readonly subscriptions: RecordedSubscription[];
  readonly responses: RecordedResponse[];
  /** Delivers one message to the first recorded subscription. */
  deliver(
    message: unknown,
    metadata: MessageMetadata,
  ): Promise<void>;
}

/**
 * Builds a recording `MessageBrokerAdapter`. Contract-faithful: every member
 * records its arguments and delegates, exactly as a real adapter would be
 * observed from its decorator.
 */
function createFakeAdapter(options?: {
  ready?: boolean;
  reachable?: boolean | undefined;
  healthy?: boolean;
  withIsHealthy?: boolean;
}): FakeAdapter {
  const log: string[] = [];
  const connects = { connect: 0, disconnect: 0 };
  const publishes: { topic: string; message: unknown }[] = [];
  const publishesWithHeaders: {
    topic: string;
    message: unknown;
    headers: Readonly<Record<string, string>>;
  }[] = [];
  const requests: { topic: string; message: unknown; options?: RequestOptions }[] = [];
  const requestsWithHeaders: {
    topic: string;
    message: unknown;
    headers: Readonly<Record<string, string>>;
    options?: RequestOptions;
  }[] = [];
  const subscriptions: RecordedSubscription[] = [];
  const responses: RecordedResponse[] = [];

  const subscribe = <T>(
    topic: string,
    handler: MessageHandler<T>,
    via: SubscribeVia,
    recordOptions?: SubscribeOptions,
  ): Promise<ISubscription> => {
    subscriptions.push({
      topic,
      handler: handler as MessageHandler<unknown>,
      ...(recordOptions !== undefined ? { options: recordOptions } : {}),
      via,
    });
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  };

  const adapter: MessageBrokerAdapter = {
    connect: () => {
      connects.connect++;
      return Promise.resolve();
    },
    disconnect: () => {
      connects.disconnect++;
      return Promise.resolve();
    },
    isReady: () => options?.ready ?? true,
    reachability: () => Promise.resolve(options?.reachable ?? true),
    ...(options?.withIsHealthy
      ? { isHealthy: () => Promise.resolve(options.healthy ?? true) }
      : {}),
    publish: <T>(topic: string, message: T) => {
      publishes.push({ topic, message });
      return Promise.resolve();
    },
    publishWithHeaders: <T>(
      topic: string,
      message: T,
      headers: Readonly<Record<string, string>>,
    ) => {
      publishesWithHeaders.push({ topic, message, headers });
      return Promise.resolve();
    },
    subscribe: <T>(topic: string, handler: MessageHandler<T>, recordOptions?: SubscribeOptions) =>
      subscribe(topic, handler, 'subscribe', recordOptions),
    subscribeWithHeaders: <T>(
      topic: string,
      handler: MessageHandler<T>,
      recordOptions?: SubscribeOptions,
    ) => subscribe(topic, handler, 'subscribeWithHeaders', recordOptions),
    request: <TReq, TRes>(topic: string, message: TReq, reqOptions?: RequestOptions) => {
      requests.push({
        topic,
        message,
        ...(reqOptions !== undefined ? { options: reqOptions } : {}),
      });
      return Promise.resolve({} as TRes);
    },
    requestWithHeaders: <TReq, TRes>(
      topic: string,
      message: TReq,
      headers: Readonly<Record<string, string>>,
      reqOptions?: RequestOptions,
    ) => {
      requestsWithHeaders.push({
        topic,
        message,
        headers,
        ...(reqOptions !== undefined ? { options: reqOptions } : {}),
      });
      return Promise.resolve({} as TRes);
    },
    respond: <TReq, TRes>(
      topic: string,
      handler: RequestHandler<TReq, TRes>,
      respondOptions?: SubscribeOptions,
    ) => {
      responses.push({
        topic,
        handler: handler as RequestHandler<unknown, unknown>,
        ...(respondOptions !== undefined ? { options: respondOptions } : {}),
      });
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
  };

  return {
    adapter,
    log,
    connects,
    publishes,
    publishesWithHeaders,
    requests,
    requestsWithHeaders,
    subscriptions,
    responses,
    deliver: (message, metadata) => {
      const first = subscriptions[0];
      if (first === undefined) {
        throw new Error('no subscription recorded');
      }
      return Promise.resolve(first.handler(message, metadata));
    },
  };
}

/** A recording pass-through behaviour. */
function recorder(log: string[], label: string): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      return next();
    },
  };
}

describe('PipelinedBroker forwards every MessageBrokerAdapter member', () => {
  it('lifecycle and health members reach the underlying broker', async () => {
    const fake = createFakeAdapter({
      ready: true,
      reachable: true,
      withIsHealthy: true,
      healthy: true,
    });
    const wrapped = new PipelinedBroker(fake.adapter, []);

    await wrapped.connect();
    expect(fake.connects.connect).toBe(1);

    await wrapped.disconnect();
    expect(fake.connects.disconnect).toBe(1);

    expect(wrapped.isReady()).toBe(true);
    expect(await wrapped.reachability()).toBe(true);
    expect(await wrapped.isHealthy()).toBe(true);
  });

  it('reports healthy when the underlying broker exposes no isHealthy member', async () => {
    const fake = createFakeAdapter({ withIsHealthy: false });
    const wrapped = new PipelinedBroker(fake.adapter, []);

    expect(await wrapped.isHealthy()).toBe(true);
  });

  it('publish and publishWithHeaders reach the underlying broker verbatim', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, []);
    const message = { orderId: 7 };

    await wrapped.publish('orders', message);
    await wrapped.publishWithHeaders('orders', message, { 'x-seen': 'true' });

    expect(fake.publishes).toEqual([{ topic: 'orders', message }]);
    expect(fake.publishesWithHeaders).toEqual([
      { topic: 'orders', message, headers: { 'x-seen': 'true' } },
    ]);
  });

  it('request and requestWithHeaders reach the underlying broker verbatim', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, []);
    const message = { q: 'price-of' };

    await wrapped.request('pricing', message, { timeoutMs: 1234 });
    await wrapped.requestWithHeaders('pricing', message, { 'x-a': 'b' }, { timeoutMs: 5 });

    expect(fake.requests).toEqual([{ topic: 'pricing', message, options: { timeoutMs: 1234 } }]);
    expect(fake.requestsWithHeaders).toEqual([{
      topic: 'pricing',
      message,
      headers: { 'x-a': 'b' },
      options: { timeoutMs: 5 },
    }]);
  });

  it('routes subscribe through the underlying subscribeWithHeaders — the single insertion point', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, []);
    const handler: MessageHandler<string> = () => {};

    await wrapped.subscribe('orders', handler, { queue: 'workers' });

    expect(fake.subscriptions).toHaveLength(1);
    expect(fake.subscriptions[0]?.via).toBe('subscribeWithHeaders');
    expect(fake.subscriptions[0]?.topic).toBe('orders');
    expect(fake.subscriptions[0]?.options).toEqual({ queue: 'workers' });
  });

  it('is NOT exported from the package barrel', () => {
    expect(
      (messaging as unknown as Record<string, unknown>).PipelinedBroker,
    ).toBeUndefined();
  });
});

describe('PipelinedBroker composes the behaviour chain around subscribe handlers', () => {
  it('delivers the messaging envelope: kind, topic name, payload, headers — and NO attempt', async () => {
    const fake = createFakeAdapter();
    const envelopes: IngressContext[] = [];
    const wrapped = new PipelinedBroker(fake.adapter, [
      {
        handle: (ctx, next) => {
          envelopes.push(ctx);
          return next();
        },
      },
    ]);
    const message = { orderId: 42 };
    const metadata: MessageMetadata = {
      topic: 'orders',
      messageId: 'm-1',
      timestamp: new Date(0),
      headers: { 'x-trace': 'abc' },
    };

    await wrapped.subscribe('orders', () => {
      fake.log.push('handler');
    });
    await fake.deliver(message, metadata);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe('messaging');
    expect(envelopes[0]?.name).toBe('orders');
    expect(envelopes[0]?.payload).toEqual(message);
    expect(envelopes[0]?.headers).toEqual({ 'x-trace': 'abc' });
    // The messaging arm deliberately carries NO attempt: brokers redeliver
    // and none tracks a delivery count (M86 §3.3).
    expect('attempt' in (envelopes[0] as object)).toBe(false);
    expect(fake.log).toEqual(['handler']);
  });

  it('omits the headers member when the transport metadata carried none', async () => {
    const fake = createFakeAdapter();
    const envelopes: IngressContext[] = [];
    const wrapped = new PipelinedBroker(fake.adapter, [
      {
        handle: (ctx, next) => {
          envelopes.push(ctx);
          return next();
        },
      },
    ]);

    await wrapped.subscribe('orders', () => {});
    await fake.deliver({ n: 1 }, { topic: 'orders' });

    expect(envelopes).toHaveLength(1);
    expect('headers' in (envelopes[0] as object)).toBe(false);
  });

  it('runs behaviours in declared order, handler last', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, [
      recorder(fake.log, 'first'),
      recorder(fake.log, 'second'),
    ]);

    await wrapped.subscribe('orders', () => {
      fake.log.push('handler');
    });
    await fake.deliver({ n: 1 }, { topic: 'orders' });

    expect(fake.log).toEqual(['first', 'second', 'handler']);
  });

  it('a behaviour returning without next() short-circuits the handler', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, [
      {
        handle: (_ctx, _next) => {
          fake.log.push('short-circuit');
          // Returns WITHOUT calling next().
        },
      },
    ]);

    await wrapped.subscribe('orders', () => {
      fake.log.push('handler');
    });
    await fake.deliver({ n: 1 }, { topic: 'orders' });

    expect(fake.log).toEqual(['short-circuit']);
  });

  it('a behaviour throw rejects the delivery on the existing handler failure path', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, [
      {
        handle: () => {
          throw new Error('behaviour exploded');
        },
      },
    ]);

    await wrapped.subscribe('orders', () => {
      fake.log.push('handler');
    });
    await expect(fake.deliver({ n: 1 }, { topic: 'orders' })).rejects.toThrow('behaviour exploded');
    expect(fake.log).toEqual([]);
  });

  it('reads the behaviour list LIVE: entries appended after subscribe still wrap delivery', async () => {
    const fake = createFakeAdapter();
    const chain: IIngressBehavior[] = [];
    const wrapped = new PipelinedBroker(fake.adapter, chain);

    await wrapped.subscribe('orders', () => {
      fake.log.push('handler');
    });

    // No behaviour yet — direct delivery, matching the registration-time
    // configuration the plugin had.
    await fake.deliver({ n: 1 }, { topic: 'orders' });
    expect(fake.log).toEqual(['handler']);

    // The plugin's onInit appends factory-resolved behaviours to the SAME
    // array; the very next delivery must run through them.
    chain.push(recorder(fake.log, 'late'));
    await fake.deliver({ n: 2 }, { topic: 'orders' });
    expect(fake.log).toEqual(['handler', 'late', 'handler']);
  });
});

describe('PipelinedBroker forwards respond UNWRAPPED (M86 §3.12)', () => {
  it('hands the responder to the underlying broker by the SAME reference, never chained', async () => {
    const fake = createFakeAdapter();
    const wrapped = new PipelinedBroker(fake.adapter, [recorder(fake.log, 'behaviour')]);
    const responder: RequestHandler<{ q: string }, number> = () => 42;

    await wrapped.respond('pricing', responder, { queue: 'responders' });

    expect(fake.responses).toHaveLength(1);
    expect(fake.responses[0]?.topic).toBe('pricing');
    expect(fake.responses[0]?.options).toEqual({ queue: 'responders' });
    // Identity: the underlying broker received the application's own handler,
    // not a chain-wrapped closure — the deferral is pinned, not assumed.
    expect(fake.responses[0]?.handler).toBe(responder);

    // Calling it runs the responder directly: no behaviour ran, the result is
    // returned as-is.
    const reply = await fake.responses[0]?.handler({ q: 'price-of' }, { topic: 'pricing' });
    expect(reply).toBe(42);
    expect(fake.log).toEqual([]);
  });
});

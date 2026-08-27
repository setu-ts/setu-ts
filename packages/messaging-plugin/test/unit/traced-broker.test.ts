import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ISubscription,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import { TRACEPARENT_HEADER } from '@setu-ts/common';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { createFakeTracerHost } from '../../../telemetry-plugin/test/fixtures/fake-tracer-host.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import { TracedBroker } from '../../src/tracing/traced-broker.ts';

describe('TracedBroker', () => {
  it('injects a producer context and parents a consumer span from delivery metadata', async () => {
    let publishedHeaders: Readonly<Record<string, string>> = {};
    let delivery:
      | ((
        message: unknown,
        metadata: { topic: string; headers?: Readonly<Record<string, string>> },
      ) => void | Promise<void>)
      | undefined;
    const inner: MessageBrokerAdapter = {
      connect: async () => {},
      disconnect: async () => {},
      isReady: () => true,
      reachability: () => Promise.resolve(true),
      isHealthy: () => Promise.resolve(true),
      publish: async () => {},
      publishWithHeaders: (_topic, _message, headers) => {
        publishedHeaders = headers;
        return Promise.resolve();
      },
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      subscribeWithHeaders: (_topic, handler) => {
        delivery = (message, metadata) => handler(message as never, metadata);
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
      request: <TReq, TRes>(_topic: string, _message: TReq, _options?: RequestOptions) =>
        Promise.resolve(undefined as TRes),
      respond: <TReq, TRes>(
        _topic: string,
        _handler: RequestHandler<TReq, TRes>,
        _options?: SubscribeOptions,
      ): Promise<ISubscription> => Promise.resolve({ unsubscribe: async () => {} }),
    };
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner, new TelemetryService(host), 'memory');

    await broker.publish('orders', { id: '1' });
    expect(publishedHeaders[TRACEPARENT_HEADER]).toMatch(/^00-/);

    let received = false;
    await broker.subscribe('orders', () => {
      received = true;
      return Promise.resolve();
    });
    await delivery?.({ id: '1' }, { topic: 'orders', headers: publishedHeaders });
    expect(received).toBe(true);
    expect(host.recordedSpans.map((span) => span.name)).toEqual([
      'publish orders',
      'receive orders',
    ]);
    expect(host.recordedSpans[1].attributes['messaging.operation']).toBe('receive');

    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
    await broker.request('orders', { id: '1' });
    await broker.respond('orders', () => Promise.resolve({ ok: true }));
    await broker.disconnect();
  });

  it('uses the healthy fallback when the wrapped broker has no health port', async () => {
    const inner = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      reachability: () => Promise.resolve(undefined),
      publish: () => Promise.resolve(),
      publishWithHeaders: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(undefined),
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    } as MessageBrokerAdapter;
    const broker = new TracedBroker(inner, new TelemetryService(createFakeTracerHost()), 'memory');
    expect(await broker.isHealthy()).toBe(true);
  });
});

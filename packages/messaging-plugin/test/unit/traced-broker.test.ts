import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ISubscription,
  ITelemetryService,
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
      requestWithHeaders: <TReq, TRes>(
        _topic: string,
        _message: TReq,
        _headers: Readonly<Record<string, string>>,
        _options?: RequestOptions,
      ) => Promise.resolve(undefined as TRes),
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
      requestWithHeaders: () => Promise.resolve(undefined),
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    } as MessageBrokerAdapter;
    const broker = new TracedBroker(inner, new TelemetryService(createFakeTracerHost()), 'memory');
    expect(await broker.isHealthy()).toBe(true);
  });

  it('preserves caller headers when the span context cannot form a traceparent', async () => {
    let requestHeaders: Readonly<Record<string, string>> = {};
    let publishHeaders: Readonly<Record<string, string>> = {};
    const inner = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      reachability: () => Promise.resolve(true),
      publish: () => Promise.resolve(),
      publishWithHeaders: (
        _topic: string,
        _message: unknown,
        headers: Readonly<Record<string, string>>,
      ) => {
        publishHeaders = headers;
        return Promise.resolve();
      },
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(undefined),
      requestWithHeaders: (
        _topic: string,
        _message: unknown,
        headers: Readonly<Record<string, string>>,
      ) => {
        requestHeaders = headers;
        return Promise.resolve(undefined);
      },
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    } as MessageBrokerAdapter;
    const telemetry = {
      withSpan: <T>(_name: string, fn: (span: unknown) => Promise<T>) =>
        fn({
          spanContext: () => ({
            traceId: '0'.repeat(32),
            spanId: '0'.repeat(16),
            traceFlags: '01',
          }),
        }),
    } as unknown as ITelemetryService;
    const broker = new TracedBroker(inner, telemetry, 'memory');

    await broker.publishWithHeaders('orders', { id: '1' }, { correlation: 'c-1' });
    await broker.requestWithHeaders('orders', { id: '1' }, { correlation: 'c-1' });
    expect(publishHeaders).toEqual({ correlation: 'c-1' });
    expect(requestHeaders).toEqual({ correlation: 'c-1' });
  });

  it('creates a responder consumer span from request metadata', async () => {
    let responder:
      | ((
        message: unknown,
        metadata: { topic: string; messageId?: string; headers?: Readonly<Record<string, string>> },
      ) => Promise<unknown>)
      | undefined;
    const inner = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      reachability: () => Promise.resolve(true),
      publish: () => Promise.resolve(),
      publishWithHeaders: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(undefined),
      requestWithHeaders: () => Promise.resolve(undefined),
      respond: (
        _topic: string,
        handler: (
          message: unknown,
          metadata: {
            topic: string;
            messageId?: string;
            headers?: Readonly<Record<string, string>>;
          },
        ) => Promise<unknown>,
      ) => {
        responder = handler;
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
    } as MessageBrokerAdapter;
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner, new TelemetryService(host), 'memory');

    await broker.respond('orders', () => Promise.resolve({ ok: true }));
    await responder?.(
      { id: '1' },
      {
        topic: 'rr.req.orders',
        messageId: 'request-1',
        headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      },
    );

    expect(host.recordedSpans[0]?.name).toBe('receive rr.req.orders');
    expect(host.recordedSpans[0]?.attributes['messaging.message.id']).toBe('request-1');
  });
});

/**
 * A recording inner broker covering the whole internal seam, so each test below
 * drives one branch rather than rebuilding the fake.
 */
function recordingInner(): {
  broker: MessageBrokerAdapter;
  calls: string[];
  // Declared as a required member unioned with `undefined` rather than
  // optional: `exactOptionalPropertyTypes` rejects a getter that may yield
  // `undefined` for an optional property.
  deliver:
    | ((
      message: unknown,
      metadata: {
        topic: string;
        messageId?: string;
        headers?: Readonly<Record<string, string>>;
      },
    ) => void | Promise<void>)
    | undefined;
  headers: () => Readonly<Record<string, string>>;
} {
  const calls: string[] = [];
  let seen: Readonly<Record<string, string>> = {};
  const state: {
    deliver?: (
      message: unknown,
      metadata: {
        topic: string;
        messageId?: string;
        headers?: Readonly<Record<string, string>>;
      },
    ) => void | Promise<void>;
  } = {};
  const broker = {
    connect: () => {
      calls.push('connect');
      return Promise.resolve();
    },
    disconnect: () => {
      calls.push('disconnect');
      return Promise.resolve();
    },
    isReady: () => {
      calls.push('isReady');
      return true;
    },
    reachability: () => {
      calls.push('reachability');
      return Promise.resolve(undefined);
    },
    isHealthy: () => {
      calls.push('isHealthy');
      return Promise.resolve(false);
    },
    publish: () => Promise.resolve(),
    publishWithHeaders: (
      _topic: string,
      _message: unknown,
      headers: Readonly<Record<string, string>>,
    ) => {
      calls.push('publishWithHeaders');
      seen = headers;
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    subscribeWithHeaders: (
      _topic: string,
      handler: (
        message: unknown,
        metadata: {
          topic: string;
          messageId?: string;
          headers?: Readonly<Record<string, string>>;
        },
      ) => void | Promise<void>,
    ) => {
      calls.push('subscribeWithHeaders');
      state.deliver = handler;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    request: () => Promise.resolve(undefined),
    requestWithHeaders: () => {
      calls.push('requestWithHeaders');
      return Promise.resolve({ ok: true } as unknown);
    },
    respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  } as unknown as MessageBrokerAdapter;

  return {
    broker,
    calls,
    get deliver() {
      return state.deliver;
    },
    headers: () => seen,
  };
}

describe('TracedBroker branch coverage', () => {
  it('routes the public publish/subscribe/request through the traced path', async () => {
    const inner = recordingInner();
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner.broker, new TelemetryService(host), 'memory');

    await broker.publish('orders', { id: 1 });
    await broker.subscribe('orders', () => {});
    await broker.request('orders', { id: 1 });

    // The public members must reach the *WithHeaders seam, not the inner
    // broker's plain members — otherwise a plain publish carries no trace.
    expect(inner.calls).toContain('publishWithHeaders');
    expect(inner.calls).toContain('subscribeWithHeaders');
    expect(inner.calls).toContain('requestWithHeaders');
    expect(host.recordedSpans.map((s) => s.name)).toEqual([
      'publish orders',
      'publish rr.req.orders',
    ]);
  });

  it('delegates lifecycle and health to the wrapped broker unchanged', async () => {
    const inner = recordingInner();
    const broker = new TracedBroker(
      inner.broker,
      new TelemetryService(createFakeTracerHost()),
      'x',
    );

    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(false);
    await broker.disconnect();

    expect(inner.calls).toEqual([
      'connect',
      'isReady',
      'reachability',
      'isHealthy',
      'disconnect',
    ]);
  });

  it('traces a delivery that carries neither headers nor a message id', async () => {
    const inner = recordingInner();
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner.broker, new TelemetryService(host), 'memory');

    await broker.subscribeWithHeaders('orders', () => {});
    await inner.deliver?.({ id: 1 }, { topic: 'orders' });

    const span = host.recordedSpans[0];
    expect(span?.name).toBe('receive orders');
    // No id was delivered, so the attribute is absent rather than `undefined`.
    expect(span?.attributes['messaging.message.id']).toBeUndefined();
    expect(span?.attributes['messaging.system']).toBe('memory');
    expect(span?.attributes['messaging.operation']).toBe('receive');
    expect(span?.ended).toBe(true);
  });

  it('ends the consumer span and records the exception when the handler throws', async () => {
    const inner = recordingInner();
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner.broker, new TelemetryService(host), 'memory');

    await broker.subscribeWithHeaders('orders', () => {
      throw new Error('handler blew up');
    });

    await expect(inner.deliver?.({ id: 1 }, { topic: 'orders' })).rejects.toThrow(
      'handler blew up',
    );

    // A leaked span is the failure this guards: the status, the exception and
    // `end()` must all land even though the handler rejected.
    const span = host.recordedSpans[0];
    expect(span?.status).toBe('error');
    expect(span?.exceptions.map((e) => e.message)).toEqual(['handler blew up']);
    expect(span?.ended).toBe(true);
  });

  it('traces a responder delivery carrying neither headers nor a message id', async () => {
    // The `respond` path has its own metadata branches, separate from
    // `subscribeWithHeaders`. Covering only the fully-populated case leaves the
    // absent-metadata arms of the RPC consumer span unexercised.
    let responder:
      | ((
        message: unknown,
        metadata: {
          topic: string;
          messageId?: string;
          headers?: Readonly<Record<string, string>>;
        },
      ) => Promise<unknown>)
      | undefined;
    const inner = {
      ...recordingInner().broker,
      respond: (
        _topic: string,
        handler: (
          message: unknown,
          metadata: {
            topic: string;
            messageId?: string;
            headers?: Readonly<Record<string, string>>;
          },
        ) => Promise<unknown>,
      ) => {
        responder = handler;
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
    } as unknown as MessageBrokerAdapter;
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner, new TelemetryService(host), 'memory');

    await broker.respond('orders', () => Promise.resolve({ ok: true }));
    await responder?.({ id: '1' }, { topic: 'rr.req.orders' });

    const span = host.recordedSpans[0];
    expect(span?.name).toBe('receive rr.req.orders');
    expect(span?.attributes['messaging.message.id']).toBeUndefined();
    expect(span?.attributes['messaging.operation']).toBe('receive');
    expect(span?.ended).toBe(true);
  });

  it('propagates a producer span failure without losing the span', async () => {
    const inner = {
      ...recordingInner().broker,
      publishWithHeaders: () => Promise.reject(new Error('transport down')),
    } as unknown as MessageBrokerAdapter;
    const host = createFakeTracerHost();
    const broker = new TracedBroker(inner, new TelemetryService(host), 'memory');

    await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('transport down');
    expect(host.recordedSpans[0]?.status).toBe('error');
    expect(host.recordedSpans[0]?.ended).toBe(true);
  });
});

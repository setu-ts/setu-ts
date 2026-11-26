import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, MessageHandler } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';
import type { ICustomMessageBroker } from '../../src/index.ts';
import { asBrokerAdapter } from '../../src/brokers/custom-adapter.ts';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { createFakeTracerHost } from '../../../telemetry-plugin/test/fixtures/fake-tracer-host.ts';

function custom(headers: boolean): ICustomMessageBroker {
  let handler: MessageHandler | undefined;
  const broker: ICustomMessageBroker = {
    connect: async () => {},
    disconnect: async () => {},
    publish: async (topic, message) => {
      await handler?.(message, { topic });
    },
    subscribe: (_topic, receive) => {
      handler = receive as MessageHandler;
      return Promise.resolve({ fanOut: true, unsubscribe: async () => {} });
    },
    request: () => Promise.resolve('reply' as never),
    respond: () => Promise.resolve({ unsubscribe: async () => {} }),
    ...(headers
      ? ({
          publishWithHeaders: async (topic, message, framework) => {
            await handler?.(message, { topic, headers: framework });
          },
          requestWithHeaders: () => Promise.resolve('header-reply' as never),
        } satisfies Partial<ICustomMessageBroker>)
      : {}),
  };
  return broker;
}

describe('Custom broker contract', () => {
  it.each([false, true])(
    'validates every publish entry with header channel=%s',
    async (headers) => {
      const instance = custom(headers);
      Object.assign(instance, {
        isReady: () => true,
        reachability: () => Promise.resolve(undefined),
        isHealthy: () => Promise.resolve(true),
        subscribeWithHeaders: vi.fn(),
      });
      const adapter = asBrokerAdapter(instance);
      expect(adapter).not.toBe(instance);
      await expect(
        adapter.publish('orders', {}, { headers: { traceparent: 'forged' } }),
      ).rejects.toThrow('reserved');
      await expect(
        adapter.publishWithHeaders('orders', {}, {}, { headers: { traceparent: 'forged' } }),
      ).rejects.toThrow('reserved');
      expect(await adapter.reachability()).toBe(true);
    },
  );
  it('warns once across missing channels and uses the optional request channel', async () => {
    const warn = vi.fn();
    const instance = custom(false);
    const adapter = asBrokerAdapter(instance, warn);
    await adapter.publish('orders', {});
    await adapter.publishWithHeaders('orders', {}, { traceparent: 'parent' });
    await adapter.request('orders', {});
    expect(warn).toHaveBeenCalledTimes(1);
    instance.requestWithHeaders = () => Promise.resolve('header-reply' as never);
    expect(await adapter.requestWithHeaders('orders', {}, { traceparent: 'parent' })).toBe(
      'header-reply',
    );
  });
  it('parents the consumer span through metadata.headers in a kernel app', async () => {
    const host = createFakeTracerHost();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'telemetry-host',
          version: '1',
          provides: [CAPABILITIES.TELEMETRY],
          register(ctx) {
            ctx.services.register(CAPABILITIES.TELEMETRY, new TelemetryService(host));
          },
        },
        MessagingPlugin({ broker: 'custom', instance: custom(true) }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const receive = vi.fn();
      await broker.subscribe('orders', receive, { fanOut: true });
      await broker.publish('orders', { id: 'o' });
      expect(receive).toHaveBeenCalled();
      const producer = host.recordedSpans.find((span) => span.name === 'publish orders')!;
      const parent = host.recordedCalls.find((call) => call.args[0] === 'receive orders')!
        .args[1] as { parentContext: { traceId: string; spanId: string } };
      expect(parent.parentContext.traceId).toBe(producer.context.traceId);
      expect(parent.parentContext.spanId).toBe(producer.context.spanId);
    } finally {
      await app.stop();
    }
  });
});

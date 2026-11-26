import { vi } from 'vitest';
import type {
  IPubSubTransport,
  IPubSubSubscription,
  PubSubOpenOptions,
} from '../../src/brokers/pubsub-broker.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';

interface IPubSubFake {
  readonly opens: Array<{
    topic: string;
    name: string;
    deliver: Parameters<IPubSubTransport['open']>[2];
    options?: PubSubOpenOptions;
    close: ReturnType<typeof vi.fn>;
  }>;
  readonly response: { created?: boolean; existing?: IPubSubSubscription['existing'] };
  readonly transport: IPubSubTransport;
}
interface IServiceBusFake {
  readonly opens: Array<{
    topic: string;
    name: string;
    deliver: Parameters<IServiceBusTransport['open']>[2];
    close: ReturnType<typeof vi.fn>;
  }>;
  readonly transport: IServiceBusTransport;
}

/** Records optional policies and exposes deliveries and unexpected stream closure. */
export function pubSubTransport(): IPubSubFake {
  const opens: Array<{
    topic: string;
    name: string;
    deliver: Parameters<IPubSubTransport['open']>[2];
    options?: PubSubOpenOptions;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const response: { created?: boolean; existing?: IPubSubSubscription['existing'] } = {
    created: true,
  };
  const transport: IPubSubTransport = {
    publish: vi.fn(() => Promise.resolve()),
    open: vi.fn((topic, name, deliver, options) => {
      const close = vi.fn(() => Promise.resolve());
      opens.push({ topic, name, deliver, ...(options === undefined ? {} : { options }), close });
      return Promise.resolve({
        close,
        ...(response.created === undefined ? {} : { created: response.created }),
        ...(response.existing === undefined ? {} : { existing: response.existing }),
      });
    }),
    createSubscription: vi.fn(() => Promise.resolve()),
    deleteSubscription: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    topicExists: vi.fn(() => Promise.resolve(true)),
    topicHasSubscriptions: vi.fn(() => Promise.resolve(true)),
    isHealthy: vi.fn(() => Promise.resolve(true)),
  };
  return { transport, opens, response };
}

/** Supplies every optional Service Bus retry seam and records receiver lifetime. */
export function serviceBusTransport(): IServiceBusFake {
  const opens: Array<{
    topic: string;
    name: string;
    deliver: Parameters<IServiceBusTransport['open']>[2];
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const transport: IServiceBusTransport = {
    send: vi.fn(() => Promise.resolve()),
    open: vi.fn((topic, name, deliver) => {
      const close = vi.fn(() => Promise.resolve());
      opens.push({ topic, name, deliver, close });
      return Promise.resolve({ close });
    }),
    createSubscription: vi.fn(() => Promise.resolve()),
    deleteSubscription: vi.fn(() => Promise.resolve()),
    getSubscription: vi.fn(() => Promise.resolve({ maxDeliveryCount: 10 })),
    close: vi.fn(() => Promise.resolve()),
  };
  return { transport, opens };
}

/** Flushes detached message callbacks without advancing wall time. */
export async function flushCloud(): Promise<void> {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}

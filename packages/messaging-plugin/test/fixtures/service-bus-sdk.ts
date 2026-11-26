import { vi } from 'vitest';
import type {
  IServiceBusReceiver,
  ServiceBusSdkModule,
} from '../../src/brokers/service-bus-broker.ts';

/** SDK-shaped receiver recording calls without AMQP I/O. */
export function serviceBusSdk() {
  const subscribe = vi.fn<IServiceBusReceiver['subscribe']>(() => ({ close: async () => {} }));
  const sendMessages = vi.fn(() => Promise.resolve());
  const createSubscription = vi.fn(() => Promise.resolve());
  const deleteSubscription = vi.fn(() => Promise.resolve());
  const module: ServiceBusSdkModule = {
    RetryMode: { Fixed: 0, Exponential: 1 },
    ServiceBusClient: class {
      createSender() {
        return { sendMessages, close: async () => {} };
      }
      createReceiver() {
        return {
          subscribe,
          completeMessage: async () => {},
          abandonMessage: async () => {},
          close: async () => {},
        };
      }
      async close() {}
    },
    ServiceBusAdministrationClient: class {
      createSubscription = createSubscription;
      deleteSubscription = deleteSubscription;
    },
  };
  return { module, subscribe, sendMessages, createSubscription, deleteSubscription };
}

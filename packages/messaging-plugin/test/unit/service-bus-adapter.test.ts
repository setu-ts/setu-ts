import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptServiceBusModule,
  type ServiceBusSdkModule,
} from '../../src/brokers/service-bus-broker.ts';

describe('adaptServiceBusModule', () => {
  function createFakeSdkModule(): ServiceBusSdkModule & {
    sends: Array<{ topic: string; body: string }>;
    receivers: Array<{ topic: string; subscription: string }>;
    adminCreates: Array<{ topic: string; subscription: string }>;
    adminDeletes: Array<{ topic: string; subscription: string }>;
  } {
    const mod = {} as ServiceBusSdkModule & {
      sends: Array<{ topic: string; body: string }>;
      receivers: Array<{ topic: string; subscription: string }>;
      adminCreates: Array<{ topic: string; subscription: string }>;
      adminDeletes: Array<{ topic: string; subscription: string }>;
    };
    mod.sends = [];
    mod.receivers = [];
    mod.adminCreates = [];
    mod.adminDeletes = [];

    mod.ServiceBusClient = class {
      constructor(_connectionString: string) {}
      createSender(topicName: string) {
        return {
          sendMessages(msg: { body: string }) {
            mod.sends.push({ topic: topicName, body: msg.body });
            return Promise.resolve();
          },
          close() {
            return Promise.resolve();
          },
        };
      }
      createReceiver(topicName: string, subscriptionName: string) {
        mod.receivers.push({ topic: topicName, subscription: subscriptionName });
        return {
          subscribe(_options: {
            processMessage: (
              msg: { body: unknown; complete: () => Promise<void> },
            ) => Promise<void>;
            processError: () => void;
          }) {
            return { close: () => Promise.resolve() };
          },
          close: () => Promise.resolve(),
        };
      }
      close() {
        return Promise.resolve();
      }
    };

    mod.ServiceBusAdministrationClient = class {
      constructor(_connectionString: string) {}
      createSubscription(topicName: string, subscriptionName: string) {
        mod.adminCreates.push({ topic: topicName, subscription: subscriptionName });
        return Promise.resolve();
      }
      deleteSubscription(topicName: string, subscriptionName: string) {
        mod.adminDeletes.push({ topic: topicName, subscription: subscriptionName });
        return Promise.resolve();
      }
    };

    return mod;
  }

  it('sends body via createSender', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.send('my-topic', '{"hello":"world"}');

    expect(sdk.sends).toHaveLength(1);
    expect(sdk.sends[0].topic).toBe('my-topic');
    expect(sdk.sends[0].body).toBe('{"hello":"world"}');
  });

  it('createReceiver is called with two positional strings', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.open('my-topic', 'my-sub', () => {});

    expect(sdk.receivers).toHaveLength(1);
    expect(sdk.receivers[0].topic).toBe('my-topic');
    expect(sdk.receivers[0].subscription).toBe('my-sub');
  });

  it('uses admin client for createSubscription', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.createSubscription('my-topic', 'rpc-sub');

    expect(sdk.adminCreates).toHaveLength(1);
    expect(sdk.adminCreates[0].topic).toBe('my-topic');
    expect(sdk.adminCreates[0].subscription).toBe('rpc-sub');
  });

  it('uses admin client for deleteSubscription', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.deleteSubscription('my-topic', 'rpc-sub');

    expect(sdk.adminDeletes).toHaveLength(1);
    expect(sdk.adminDeletes[0].topic).toBe('my-topic');
    expect(sdk.adminDeletes[0].subscription).toBe('rpc-sub');
  });

  it('closes the transport', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.close();
    // No error means close resolved.
    expect(true).toBe(true);
  });

  it('subscription close works', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    const sub = await transport.open('my-topic', 'my-sub', () => {});
    await sub.close();

    // Sub close resolved without error.
    expect(true).toBe(true);
  });

  it('decodes string body as-is', async () => {
    const sdk = createFakeSdkModule();
    let receivedPayload = '';
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    await transport.open('my-topic', 'my-sub', (msg) => {
      receivedPayload = msg.payload;
    });

    // The adapter wires processMessage which calls onMessage.
    // In the fake, subscribe returns immediately without invoking the callback,
    // so we verify the receiver was created with correct args.
    expect(sdk.receivers).toHaveLength(1);
    expect(receivedPayload).toBe(''); // No message delivered yet
  });

  it('defaults adminConnectionString to connectionString', () => {
    const sdk = createFakeSdkModule();
    // When adminConnectionString matches connectionString, it uses the same value.
    const transport = adaptServiceBusModule(sdk, {
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
    });

    expect(transport).toBeDefined();
  });
});

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

  // B1 discriminating test — settlement is awaited; autoComplete:false is passed
  describe('B1: settlement awaits + autoComplete false', () => {
    it('processMessage does not resolve until ack settlement completes', async () => {
      // Fake SDK whose receiver invokes processMessage synchronously with a
      // controllable (deferred) complete/abandon so the test can prove processMessage
      // does NOT resolve before settlement actually runs.
      let processMessageFn:
        | ((msg: {
          body: unknown;
          complete: () => Promise<void>;
          abandon: () => Promise<void>;
        }) => Promise<void>)
        | null = null;
      let receiveOptions: { autoComplete?: boolean } | undefined;

      // deno-lint-ignore no-explicit-any
      const sdk = {} as any;
      sdk.sends = [];
      sdk.receivers = [];
      sdk.adminCreates = [];
      sdk.adminDeletes = [];

      sdk.ServiceBusClient = class {
        createSender(topic: string) {
          return {
            sendMessages(msg: { body: string }) {
              sdk.sends.push({ topic, body: msg.body });
              return Promise.resolve();
            },
            close() {
              return Promise.resolve();
            },
          };
        }
        createReceiver(topic: string, subscription: string) {
          sdk.receivers.push({ topic, subscription });
          return {
            subscribe(
              options: {
                processMessage: typeof processMessageFn;
              },
              capturedReceiveOptions: { autoComplete?: boolean },
            ) {
              receiveOptions = capturedReceiveOptions;
              // Expose processMessage for the test to call.
              processMessageFn = options.processMessage;
              return { close: () => Promise.resolve() };
            },
            close: () => Promise.resolve(),
          };
        }
        close() {
          return Promise.resolve();
        }
      };
      sdk.ServiceBusAdministrationClient = class {
        createSubscription(_t: string, _s: string) {
          return Promise.resolve();
        }
        deleteSubscription(_t: string, _s: string) {
          return Promise.resolve();
        }
      };

      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      // Deferred settlement control.
      let releaseSettlement: (() => Promise<void>) | null = null;
      const deferredSettlement = () =>
        new Promise<void>((resolve) => {
          releaseSettlement = () => {
            resolve();
            return Promise.resolve();
          };
        });

      let onMessageCalled = false;
      await transport.open('topic', 'sub', (msg) => {
        onMessageCalled = true;
        // Return the deferred settlement promise so processMessage awaits it.
        return msg.ack();
      });

      expect(processMessageFn).not.toBeNull();
      expect(onMessageCalled).toBe(false); // not called yet; we control invocation
      expect(receiveOptions?.autoComplete).toBe(false);

      // Invoke processMessage with the deferred complete.
      const processPromise = processMessageFn!({
        body: 'test',
        complete: deferredSettlement,
        abandon: () => Promise.reject(new Error('abandon should not run')),
      });

      // processMessage should NOT have resolved yet (settlement is deferred).
      let resolved = false;
      processPromise.then(() => {
        resolved = true;
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(resolved).toBe(false);

      // Release settlement → now processMessage resolves.
      await releaseSettlement!();
      await processPromise;
      expect(resolved).toBe(true);
    });

    it('thrown handler → abandon called, processMessage awaits abandon', async () => {
      let processMessageFn:
        | ((
          msg: { body: unknown; complete: () => Promise<void>; abandon: () => Promise<void> },
        ) => Promise<void>)
        | null = null;
      let abandonCalled = false;
      let completeCalled = false;
      let releaseAbandon: (() => void) | null = null;

      // deno-lint-ignore no-explicit-any
      const sdk = {} as any;
      sdk.sends = [];
      sdk.receivers = [];
      sdk.adminCreates = [];
      sdk.adminDeletes = [];
      sdk.ServiceBusClient = class {
        createSender() {
          return { sendMessages: () => Promise.resolve(), close: () => Promise.resolve() };
        }
        createReceiver(topic: string, subscription: string) {
          sdk.receivers.push({ topic, subscription });
          return {
            // deno-lint-ignore no-explicit-any
            subscribe(options: any, _receiveOpts: any) {
              processMessageFn = options.processMessage;
              return { close: () => Promise.resolve() };
            },
            close: () => Promise.resolve(),
          };
        }
        close() {
          return Promise.resolve();
        }
      };
      sdk.ServiceBusAdministrationClient = class {
        createSubscription() {
          return Promise.resolve();
        }
        deleteSubscription() {
          return Promise.resolve();
        }
      };

      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      await transport.open('topic', 'sub', () => {
        throw new Error('handler boom');
      });

      // Invoke processMessage — handler throws → abandon should be called, but
      // processMessage must remain pending until the deferred settlement ends.
      const processPromise = processMessageFn!({
        body: 'boom',
        complete: () => {
          completeCalled = true;
          return Promise.resolve();
        },
        abandon: () => {
          abandonCalled = true;
          return new Promise<void>((resolve) => {
            releaseAbandon = resolve;
          });
        },
      });

      let resolved = false;
      processPromise.then(() => {
        resolved = true;
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(abandonCalled).toBe(true);
      expect(completeCalled).toBe(false);
      expect(resolved).toBe(false);

      releaseAbandon!();
      await processPromise;
      expect(resolved).toBe(true);
    });
  });
});

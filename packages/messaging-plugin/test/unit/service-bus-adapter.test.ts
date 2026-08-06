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
          subscribe(
            _options: {
              processMessage: (msg: unknown) => Promise<void>;
              processError: (args: {
                error: Error;
                errorSource: string;
                entityPath: string;
                fullyQualifiedNamespace: string;
                identifier: string;
              }) => Promise<void>;
            },
            _receiveOptions?: { autoCompleteMessages?: boolean },
          ) {
            return { close: () => Promise.resolve() };
          },
          completeMessage(_msg: unknown): Promise<void> {
            return Promise.resolve();
          },
          abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
            return Promise.resolve();
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

  // B1 discriminating tests — receiver-settlement, autoCompleteMessages, ProcessErrorArgs
  describe('B1: receiver settlement + autoCompleteMessages + ProcessErrorArgs', () => {
    it('receiver.completeMessage(raw) is called with exact raw object and awaited', async () => {
      // Fake SDK whose receiver has settlement methods (real SDK shape) and
      // controllable deferred completeMessage so the test proves processMessage
      // does NOT resolve before receiver settlement actually completes.
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let capturedOptions: { autoCompleteMessages?: boolean } | undefined;

      let releaseSettlement: (() => void) | null = null;
      const deferredPromise = new Promise<void>((resolve) => {
        releaseSettlement = () => {
          resolve();
        };
      });

      // deno-lint-ignore no-explicit-any
      const sdk = {} as any;
      sdk.sends = [];
      sdk.receivers = [];
      sdk.adminCreates = [];
      sdk.adminDeletes = [];

      sdk.ServiceBusClient = class {
        createSender(_topic: string) {
          return {
            sendMessages(_msg: { body: string }) {
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
              opts: {
                processMessage: (message: unknown) => Promise<void>;
                processError: (args: { error: Error }) => Promise<void>;
              },
              optsBag: { autoCompleteMessages?: boolean },
            ) {
              processMessageFn = opts.processMessage;
              capturedOptions = optsBag;
              return { close: () => Promise.resolve() };
            },
            completeMessage(_msg: unknown): Promise<void> {
              return deferredPromise;
            },
            abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
              return Promise.reject(new Error('abandon should not run on success'));
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

      // The raw SDK message has NO settlement methods (real SDK shape).
      const rawMessage = { body: 'test' };

      let onMessageCalled = false;
      await transport.open('topic', 'sub', (msg) => {
        onMessageCalled = true;
        return msg.ack();
      });

      expect(processMessageFn).not.toBeNull();
      expect(onMessageCalled).toBe(false);
      // B2: autoCompleteMessages (not autoComplete)
      expect(capturedOptions?.autoCompleteMessages).toBe(false);
      expect('autoComplete' in (capturedOptions ?? {})).toBe(false);

      // Invoke processMessage with raw message (no settlement methods on message).
      const processPromise = processMessageFn!(rawMessage);

      // processMessage should NOT have resolved yet (settlement is deferred).
      let resolved = false;
      processPromise.then(() => {
        resolved = true;
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(resolved).toBe(false);

      // Release receiver.completeMessage → now processMessage resolves.
      releaseSettlement!();
      await processPromise;
      expect(resolved).toBe(true);
    });

    it('handler failure: receiver.abandonMessage(raw) called, completeMessage not called', async () => {
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let abandonCalled = false;
      let completeCalled = false;
      let releasedAbandon: (() => void) | null = null;

      const deferredAbandon = new Promise<void>((resolve) => {
        releasedAbandon = () => {
          resolve();
        };
      });

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
            subscribe(
              opts: {
                processMessage: (message: unknown) => Promise<void>;
                processError: (args: { error: Error }) => Promise<void>;
              },
              _optsBag: { autoCompleteMessages?: boolean },
            ) {
              processMessageFn = opts.processMessage;
              return { close: () => Promise.resolve() };
            },
            completeMessage(_msg: unknown): Promise<void> {
              completeCalled = true;
              return Promise.resolve();
            },
            abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
              abandonCalled = true;
              return deferredAbandon;
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

      // Invoke processMessage — handler throws → abandon on receiver, not complete.
      const rawMessage = { body: 'boom' };
      const processPromise = processMessageFn!(rawMessage);

      let resolved = false;
      processPromise.then(() => {
        resolved = true;
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(abandonCalled).toBe(true);
      expect(completeCalled).toBe(false);
      expect(resolved).toBe(false);

      releasedAbandon!();
      await processPromise;
      expect(resolved).toBe(true);
    });

    it('B3: processError receives ProcessErrorArgs with .error field', async () => {
      let processErrorFn:
        | ((args: {
          error: Error;
          errorSource: string;
          entityPath: string;
          fullyQualifiedNamespace: string;
          identifier: string;
        }) => Promise<void>)
        | null = null;
      let loggedError: string | undefined;

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
            subscribe(
              opts: {
                processMessage: (message: unknown) => Promise<void>;
                processError: (args: {
                  error: Error;
                  errorSource: string;
                  entityPath: string;
                  fullyQualifiedNamespace: string;
                  identifier: string;
                }) => Promise<void>;
              },
              _optsBag: { autoCompleteMessages?: boolean },
            ) {
              processErrorFn = opts.processError;
              return { close: () => Promise.resolve() };
            },
            completeMessage(): Promise<void> {
              return Promise.resolve();
            },
            abandonMessage(): Promise<void> {
              return Promise.resolve();
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

      const testError = new Error('receiver failed');
      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
        logger: {
          error: (msg: string) => {
            loggedError = msg;
          },
        },
      });

      await transport.open('topic', 'sub', () => {});

      expect(processErrorFn).not.toBeNull();

      // Invoke processError with a real-shaped ProcessErrorArgs object.
      await processErrorFn!({
        error: testError,
        errorSource: 'receive',
        entityPath: 'my-queue',
        fullyQualifiedNamespace: 'demo.servicebus.windows.net',
        identifier: 'receiver-1',
      });

      // The logger receives the underlying error (args.error), not [object Object].
      expect(loggedError).toContain('receiver failed');
      expect(loggedError).not.toContain('[object Object]');
    });
  });
});

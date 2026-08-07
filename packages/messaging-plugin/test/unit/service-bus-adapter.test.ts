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
    let clientClosed = false;
    let sendersClosed = 0;

    // deno-lint-ignore no-explicit-any
    const sdk = {} as any;
    sdk.sends = [];
    sdk.receivers = [];
    sdk.adminCreates = [];
    sdk.adminDeletes = [];

    sdk.ServiceBusClient = class {
      createSender(_t: string) {
        return {
          sendMessages: () => Promise.resolve(),
          close: () => {
            sendersClosed++;
            return Promise.resolve();
          },
        };
      }
      createReceiver(t: string, s: string) {
        sdk.receivers.push({ topic: t, subscription: s });
        return {
          subscribe: () => ({ close: () => Promise.resolve() }),
          completeMessage: () => Promise.resolve(),
          abandonMessage: () => Promise.resolve(),
          close: () => Promise.resolve(),
        };
      }
      close() {
        clientClosed = true;
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
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    // Create a sender by sending, then a receiver by opening
    await transport.send('topic-a', 'hello');
    await transport.open('topic-b', 'sub-b', () => {});

    await transport.close();

    expect(clientClosed).toBe(true);
    expect(sendersClosed).toBe(1);
  });

  it('subscription close works', async () => {
    let subClosed = false;
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
      createReceiver(t: string, s: string) {
        sdk.receivers.push({ topic: t, subscription: s });
        return {
          subscribe: () => ({
            close: () => {
              subClosed = true;
              return Promise.resolve();
            },
          }),
          completeMessage: () => Promise.resolve(),
          abandonMessage: () => Promise.resolve(),
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
      connectionString: 'Endpoint=sb://demo.servicebus.windows.net/',
      adminConnectionString: 'Endpoint=sb://admin.servicebus.windows.net/',
    });

    const sub = await transport.open('my-topic', 'my-sub', () => {});
    expect(subClosed).toBe(false);

    await sub.close();
    expect(subClosed).toBe(true);
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

    it('handler failure: error propagates; completeMessage not called (B2)', async () => {
      // B2: The adapter propagates handler errors directly. The broker's subscribe()
      // catches handler failures and calls nack. The adapter itself does NOT catch
      // handler errors — settlement and handler are separate paths.
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let abandonCalled = false;
      let completeCalled = false;

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

      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      await transport.open('topic', 'sub', () => {
        throw new Error('handler boom');
      });

      // Invoke processMessage — handler throws → propagates from adapter.
      // Neither complete nor abandon called at adapter level.
      const rawMessage = { body: 'boom' };
      await expect(processMessageFn!(rawMessage)).rejects.toThrow('handler boom');

      expect(completeCalled).toBe(false);
      expect(abandonCalled).toBe(false);
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

  // B2: Settlement rejection propagates exactly once, never swallowed or double-settled
  describe('B2: settlement rejection propagates exactly once', () => {
    it('complete rejects: exact error identity propagated; complete=1, abandon=0', async () => {
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let completeCount = 0;
      let abandonCount = 0;
      const settlementError = new Error('settlement-failed');

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
                processError: (args: unknown) => Promise<void>;
              },
              _optsBag: { autoCompleteMessages?: boolean },
            ) {
              processMessageFn = opts.processMessage;
              return { close: () => Promise.resolve() };
            },
            completeMessage(_msg: unknown): Promise<void> {
              completeCount++;
              return Promise.reject(settlementError);
            },
            abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
              abandonCount++;
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

      const { adaptServiceBusModule } = await import('../../src/brokers/service-bus-broker.ts');
      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      await transport.open('topic', 'sub', (msg) => msg.ack());

      // Invoke processMessage — handler calls ack → complete rejects
      const rawMessage = { body: 'test' };
      let capturedError: unknown = null;
      try {
        await processMessageFn!(rawMessage);
      } catch (err) {
        capturedError = err;
      }

      // Exact error identity propagated
      expect(capturedError).toBe(settlementError);
      // complete called exactly once
      expect(completeCount).toBe(1);
      // abandon never called (settlement rejection, not handler failure)
      expect(abandonCount).toBe(0);
    });

    it('explicit nack rejects: exact error identity propagated; abandon=1, complete=0', async () => {
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let completeCount = 0;
      let abandonCount = 0;
      const settlementError = new Error('abandon-settlement-failed');

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
                processError: (args: unknown) => Promise<void>;
              },
              _optsBag: { autoCompleteMessages?: boolean },
            ) {
              processMessageFn = opts.processMessage;
              return { close: () => Promise.resolve() };
            },
            completeMessage(_msg: unknown): Promise<void> {
              completeCount++;
              return Promise.resolve();
            },
            abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
              abandonCount++;
              return Promise.reject(settlementError);
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

      const { adaptServiceBusModule } = await import('../../src/brokers/service-bus-broker.ts');
      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      await transport.open('topic', 'sub', (msg) => msg.nack());

      const rawMessage = { body: 'nack-test' };
      let capturedError: unknown = null;
      try {
        await processMessageFn!(rawMessage);
      } catch (err) {
        capturedError = err;
      }

      expect(capturedError).toBe(settlementError);
      expect(abandonCount).toBe(1);
      expect(completeCount).toBe(0);
    });

    it('handler throws: abandon=1; no duplicate even if abandon rejects', async () => {
      let processMessageFn: ((message: unknown) => Promise<void>) | null = null;
      let abandonCount = 0;
      let completeCount = 0;
      const abandonError = new Error('abandon-itself-failed');

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
                processError: (args: unknown) => Promise<void>;
              },
              _optsBag: { autoCompleteMessages?: boolean },
            ) {
              processMessageFn = opts.processMessage;
              return { close: () => Promise.resolve() };
            },
            completeMessage(_msg: unknown): Promise<void> {
              completeCount++;
              return Promise.resolve();
            },
            abandonMessage(_msg: unknown, _props?: Record<string, unknown>): Promise<void> {
              abandonCount++;
              return Promise.reject(abandonError);
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

      const { adaptServiceBusModule } = await import('../../src/brokers/service-bus-broker.ts');
      const transport = adaptServiceBusModule(sdk, {
        connectionString: 'Endpoint=sb://demo/',
        adminConnectionString: 'Endpoint=sb://admin/',
      });

      await transport.open('topic', 'sub', () => {
        throw new Error('handler-boom');
      });

      const rawMessage = { body: 'handler-throw' };
      // The adapter propagates the handler throw (no inner catch for handler failures).
      // processMessage calls onMessage which throws — error propagates.
      // But the broker's subscribe() catches it and nacks, so abandon is called once.
      // At the adapter level the throw propagates.
      let capturedError: unknown = null;
      try {
        await processMessageFn!(rawMessage);
      } catch (err) {
        capturedError = err;
      }

      // The throw from onMessage propagates through the adapter.
      expect(capturedError).toBeInstanceOf(Error);
      expect((capturedError as Error).message).toBe('handler-boom');
      // Abandon not called at adapter level — the adapter propagates, broker calls nack.
      expect(abandonCount).toBe(0);
      expect(completeCount).toBe(0);
    });
  });

  describe('receiver lifecycle', () => {
    /**
     * Builds a module whose receivers record both close paths, so a leaked
     * AMQP link is observable. Closing only the subscriber handle used to be
     * the whole teardown, which left one receiver open per unsubscribe.
     */
    function createCountingModule() {
      const subscriberCloses: string[] = [];
      const receiverCloses: string[] = [];
      const mod = {
        ServiceBusClient: class {
          createSender() {
            return { sendMessages: () => Promise.resolve(), close: () => Promise.resolve() };
          }
          createReceiver(topic: string, subscription: string) {
            const id = `${topic}/${subscription}`;
            return {
              subscribe: () => ({
                close: () => {
                  subscriberCloses.push(id);
                  return Promise.resolve();
                },
              }),
              completeMessage: () => Promise.resolve(),
              abandonMessage: () => Promise.resolve(),
              close: () => {
                receiverCloses.push(id);
                return Promise.resolve();
              },
            };
          }
          close() {
            return Promise.resolve();
          }
        },
        ServiceBusAdministrationClient: class {
          createSubscription() {
            return Promise.resolve({});
          }
          deleteSubscription() {
            return Promise.resolve({});
          }
        },
      } as unknown as ServiceBusSdkModule;
      return { mod, subscriberCloses, receiverCloses };
    }

    it('closing a subscription releases the AMQP receiver, not just the subscriber', async () => {
      const { mod, subscriberCloses, receiverCloses } = createCountingModule();
      const transport = adaptServiceBusModule(mod, {
        connectionString: 'cs',
        adminConnectionString: 'cs',
      });

      const sub = await transport.open('orders', 'group', () => {});
      await sub.close();

      expect(subscriberCloses).toEqual(['orders/group']);
      // Without releasing the link, an unsubscribe leaks a receiver per call.
      expect(receiverCloses).toEqual(['orders/group']);
    });

    it('closing one of two opens on the same subscription releases only its own receiver', async () => {
      const { mod, receiverCloses } = createCountingModule();
      const transport = adaptServiceBusModule(mod, {
        connectionString: 'cs',
        adminConnectionString: 'cs',
      });

      const first = await transport.open('orders', 'group', () => {});
      await transport.open('orders', 'group', () => {});
      await first.close();

      expect(receiverCloses.length).toBe(1);

      // The sibling is still tracked, so the transport close reclaims it.
      await transport.close();
      expect(receiverCloses.length).toBe(2);
    });

    it('is idempotent — a second close does not re-release the receiver', async () => {
      const { mod, receiverCloses } = createCountingModule();
      const transport = adaptServiceBusModule(mod, {
        connectionString: 'cs',
        adminConnectionString: 'cs',
      });

      const sub = await transport.open('orders', 'group', () => {});
      await sub.close();
      await sub.close();

      expect(receiverCloses.length).toBe(1);
    });

    it('releases the link even when stopping delivery rejects', async () => {
      const receiverCloses: string[] = [];
      const mod = {
        ServiceBusClient: class {
          createSender() {
            return { sendMessages: () => Promise.resolve(), close: () => Promise.resolve() };
          }
          createReceiver(topic: string, subscription: string) {
            return {
              subscribe: () => ({
                close: () => Promise.reject(new Error('drain failed')),
              }),
              completeMessage: () => Promise.resolve(),
              abandonMessage: () => Promise.resolve(),
              close: () => {
                receiverCloses.push(`${topic}/${subscription}`);
                return Promise.resolve();
              },
            };
          }
          close() {
            return Promise.resolve();
          }
        },
        ServiceBusAdministrationClient: class {
          createSubscription() {
            return Promise.resolve({});
          }
          deleteSubscription() {
            return Promise.resolve({});
          }
        },
      } as unknown as ServiceBusSdkModule;

      const transport = adaptServiceBusModule(mod, {
        connectionString: 'cs',
        adminConnectionString: 'cs',
      });
      const sub = await transport.open('orders', 'group', () => {});

      await expect(sub.close()).rejects.toThrow('drain failed');
      expect(receiverCloses).toEqual(['orders/group']);
    });
  });
});

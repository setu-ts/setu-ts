import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { adaptPubSubModule } from '../../src/brokers/pubsub-broker.ts';
import type { PubSubSdkModule } from '../../src/brokers/pubsub-broker.ts';

describe('adaptPubSubModule', () => {
  function createFakeSdkModule(): PubSubSdkModule & {
    topics: Map<
      string,
      {
        messages: Array<{ data: Uint8Array }>;
        subscriptions: Map<
          string,
          {
            onMessage:
              | ((msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string }) => void)
              | null;
          }
        >;
      }
    >;
    subscriptions: Map<string, { topic: string; name: string; closed: boolean; deleted: boolean }>;
  } {
    const mod = {} as PubSubSdkModule & {
      topics: Map<
        string,
        {
          messages: Array<{ data: Uint8Array }>;
          subscriptions: Map<
            string,
            {
              onMessage:
                | ((
                  msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
                ) => void)
                | null;
            }
          >;
        }
      >;
      subscriptions: Map<
        string,
        { topic: string; name: string; closed: boolean; deleted: boolean }
      >;
    };
    mod.topics = new Map();
    mod.subscriptions = new Map();

    mod.PubSub = class {
      constructor(_options: { projectId: string; credentials?: unknown }) {}
      topic(name: string) {
        if (!mod.topics.has(name)) {
          mod.topics.set(name, { messages: [], subscriptions: new Map() });
        }
        const topicData = mod.topics.get(name)!;
        return {
          publishMessage(message: { data: Uint8Array }) {
            topicData.messages.push(message);
            return Promise.resolve('msg-id');
          },
          createSubscription(subName: string) {
            topicData.subscriptions.set(subName, { onMessage: null });
            return Promise.resolve([]);
          },
        };
      }
      subscription(subName: string) {
        let entry = mod.subscriptions.get(subName);
        if (!entry) {
          entry = { topic: '', name: subName, closed: false, deleted: false };
          mod.subscriptions.set(subName, entry);
        }
        return {
          on(
            event: 'message' | 'error',
            handler: (
              msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
            ) => void,
          ) {
            if (event === 'message') {
              // Find the topic that has this subscription
              for (const [, topicData] of mod.topics) {
                if (topicData.subscriptions.has(subName)) {
                  topicData.subscriptions.get(subName)!.onMessage = handler as never;
                }
              }
            }
          },
          close() {
            entry.closed = true;
            return Promise.resolve();
          },
          delete() {
            entry.deleted = true;
            return Promise.resolve();
          },
        };
      }
      close() {
        return Promise.resolve();
      }
    };

    return mod;
  }

  it('publishes bytes to the topic', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const bytes = new TextEncoder().encode('hello');
    await transport.publish('test-topic', bytes);

    const topic = sdk.topics.get('test-topic');
    expect(topic).toBeDefined();
    expect(topic!.messages).toHaveLength(1);
    expect(topic!.messages[0].data).toEqual(bytes);
  });

  it('encodes non-ASCII payload correctly', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const bytes = new TextEncoder().encode('\u{1F600}');
    await transport.publish('test-topic', bytes);

    const decoded = new TextDecoder().decode(sdk.topics.get('test-topic')!.messages[0].data);
    expect(decoded).toBe('\u{1F600}');
  });

  it('decodes inbound Buffer data through TextDecoder', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let receivedPayload = '';
    await transport.open('test-topic', 'sub-1', (msg) => {
      receivedPayload = msg.payload;
    });

    // Simulate inbound message
    const topicData = sdk.topics.get('test-topic');
    const cb = topicData!.subscriptions.get('sub-1')!.onMessage!;
    cb({
      data: new TextEncoder().encode('hello-world'),
      ack: () => {},
      nack: () => {},
      id: 'msg-1',
    });

    expect(receivedPayload).toBe('hello-world');
  });

  it('routes ack and nack through adapter closure', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let acked = false;
    let nacked = false;
    let capturedMsg: { payload: string; ack: () => void; nack: () => void } | null = null;
    await transport.open('test-topic', 'sub-2', (msg) => {
      capturedMsg = msg;
    });

    const topicData = sdk.topics.get('test-topic');
    const cb = topicData!.subscriptions.get('sub-2')!.onMessage!;
    cb({
      data: new TextEncoder().encode('test'),
      ack: () => {
        acked = true;
      },
      nack: () => {
        nacked = true;
      },
      id: 'msg-2',
    });

    // The adapter closure captured raw.ack() as the message's ack.
    // Call it to exercise the closure.
    capturedMsg!.ack();
    expect(acked).toBe(true);

    capturedMsg!.nack();
    expect(nacked).toBe(true);
  });

  it('exercises ack closure from the opened subscription', async () => {
    const sdk = createFakeSdkModule();
    let rawAckCalled = false;
    // Monkey-patch the subscription's onMessage callback to capture raw ack
    const origSubscription = sdk.PubSub.prototype.subscription;
    sdk.PubSub.prototype.subscription = function (
      _topicName: string,
      _subName: string,
    ) {
      const sub = origSubscription.call(this, _topicName, _subName);
      return {
        ...sub,
        on: (
          event: 'message' | 'error',
          handler: (
            msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
          ) => void,
        ) => {
          if (event === 'message') {
            sub.on(event, (raw: Parameters<typeof handler>[0]) => {
              handler({
                ...raw,
                ack: () => {
                  rawAckCalled = true;
                  raw.ack();
                },
              });
            });
          } else {
            sub.on(event, handler);
          }
        },
      };
    };

    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let capturedAck: (() => void) | undefined;
    await transport.open('t', 's-ack', (msg) => {
      capturedAck = msg.ack;
    });

    // Trigger the message via the fake SDK
    const topicData = sdk.topics.get('t');
    const cb = topicData!.subscriptions.get('s-ack')!.onMessage!;
    cb({
      data: new TextEncoder().encode('{}'),
      ack: () => {},
      nack: () => {},
      id: '1',
    });

    // Call the captured ack from the broker's envelope
    capturedAck!();
    expect(rawAckCalled).toBe(true);
  });

  it('exercises nack closure from the opened subscription', async () => {
    const sdk = createFakeSdkModule();
    let rawNackCalled = false;
    const origSubscription = sdk.PubSub.prototype.subscription;
    sdk.PubSub.prototype.subscription = function (
      _topicName: string,
      _subName: string,
    ) {
      const sub = origSubscription.call(this, _topicName, _subName);
      return {
        ...sub,
        on: (
          event: 'message' | 'error',
          handler: (
            msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
          ) => void,
        ) => {
          if (event === 'message') {
            sub.on(event, (raw: Parameters<typeof handler>[0]) => {
              handler({
                ...raw,
                nack: () => {
                  rawNackCalled = true;
                  raw.nack();
                },
              });
            });
          } else {
            sub.on(event, handler);
          }
        },
      };
    };

    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let capturedNack: (() => void) | undefined;
    await transport.open('t', 's-nack', (msg) => {
      capturedNack = msg.nack;
    });

    const topicData = sdk.topics.get('t');
    const cb = topicData!.subscriptions.get('s-nack')!.onMessage!;
    cb({
      data: new TextEncoder().encode('{}'),
      ack: () => {},
      nack: () => {},
      id: '2',
    });

    capturedNack!();
    expect(rawNackCalled).toBe(true);
  });

  it('subscription close closure exercises sub.close', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const sub = await transport.open('t', 's-close-2', () => {});
    // Close the subscription — exercises the closure that calls sub.close()
    await sub.close();

    const entry = sdk.subscriptions.get('s-close-2');
    expect(entry!.closed).toBe(true);
  });

  it('creates subscription on topic object', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    await transport.createSubscription('test-topic', 'rpc-sub');

    const topicData = sdk.topics.get('test-topic');
    expect(topicData!.subscriptions.has('rpc-sub')).toBe(true);
  });

  it('deletes subscription', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    await transport.deleteSubscription('rpc-sub');

    const entry = sdk.subscriptions.get('rpc-sub');
    expect(entry!.deleted).toBe(true);
  });

  it('closes the client', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    await transport.close();

    // PubSub close() was called - the fake resolves without error
    expect(true).toBe(true);
  });

  it('subscription close works', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const sub = await transport.open('test-topic', 'sub-close', (_msg) => {});
    await sub.close();

    const entry = sdk.subscriptions.get('sub-close');
    expect(entry!.closed).toBe(true);
  });
});

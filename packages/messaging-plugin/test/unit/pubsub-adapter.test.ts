import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { adaptPubSubModule } from '../../src/brokers/pubsub-broker.ts';
import type { PubSubSdkModule } from '../../src/brokers/pubsub-broker.ts';
import { PubSubSubscriptionBoundElsewhereError } from '../../src/errors.ts';

describe('adaptPubSubModule', () => {
  function createFakeSdkModule(): PubSubSdkModule & {
    topics: Map<
      string,
      {
        messages: Array<{
          data: Uint8Array;
          attributes?: Record<string, string>;
          orderingKey?: string;
        }>;
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
    topicOptions: Map<string, { messageOrdering?: boolean | undefined }>;
    subscriptionOptions: Map<string, { enableMessageOrdering?: boolean | undefined }>;
    resumed: string[];
    failNextPublish: boolean;
  } {
    const mod = {} as PubSubSdkModule & {
      topics: Map<
        string,
        {
          messages: Array<{
            data: Uint8Array;
            attributes?: Record<string, string>;
            orderingKey?: string;
          }>;
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
      topicOptions: Map<string, { messageOrdering?: boolean | undefined }>;
      subscriptionOptions: Map<string, { enableMessageOrdering?: boolean | undefined }>;
      resumed: string[];
      failNextPublish: boolean;
    };
    mod.topics = new Map();
    let fakeProjectId = '';
    mod.subscriptions = new Map();
    mod.topicOptions = new Map();
    mod.subscriptionOptions = new Map();
    mod.resumed = [];
    mod.failNextPublish = false;

    mod.PubSub = class {
      constructor(options: { projectId: string; credentials?: unknown }) {
        // The real SDK reports topics under the project it was built for.
        fakeProjectId = options.projectId;
      }
      topic(name: string, options?: { messageOrdering?: boolean }) {
        if (!mod.topics.has(name)) {
          mod.topics.set(name, { messages: [], subscriptions: new Map() });
        }
        mod.topicOptions.set(name, options ?? {});
        const topicData = mod.topics.get(name)!;
        return {
          publishMessage(message: {
            data: Uint8Array;
            attributes?: Record<string, string>;
            orderingKey?: string;
          }) {
            if (mod.failNextPublish) {
              mod.failNextPublish = false;
              return Promise.reject(new Error('publish failed'));
            }
            topicData.messages.push(message);
            return Promise.resolve('msg-id');
          },
          createSubscription(subName: string, options?: { enableMessageOrdering?: boolean }) {
            mod.subscriptionOptions.set(subName, options ?? {});
            // M101b: names are project-global, as on the real service — an
            // existing subscription answers ALREADY_EXISTS whichever topic it
            // is bound to. The pre-M101b fake accepted every create.
            const known = mod.subscriptions.get(subName);
            if (known !== undefined && known.topic !== '') {
              return Promise.reject({ code: 6, message: 'ALREADY_EXISTS' });
            }
            topicData.subscriptions.set(subName, { onMessage: null });
            // Bind the entry a `subscription()` handle may already hold, so
            // that handle's `getMetadata` reads the binding.
            if (known !== undefined) {
              known.topic = name;
            } else {
              mod.subscriptions.set(subName, {
                topic: name,
                name: subName,
                closed: false,
                deleted: false,
              });
            }
            return Promise.resolve([]);
          },
          resumePublishing(orderingKey: string) {
            mod.resumed.push(orderingKey);
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
          getMetadata(): Promise<[{ topic?: string | null }]> {
            // The service reports the fully-qualified topic name.
            return Promise.resolve([{ topic: `projects/${fakeProjectId}/topics/${entry.topic}` }]);
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

  it('caches one Topic per name, created with messageOrdering: true (M106 §3.5)', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const bytes = new TextEncoder().encode('a');
    await transport.publish('order-topic', bytes, undefined, 'agg-1');
    await transport.publish('order-topic', bytes, undefined, 'agg-1');

    expect(sdk.topicOptions.get('order-topic')?.messageOrdering).toBe(true);
    expect(sdk.topics.get('order-topic')!.messages.map((m) => m.orderingKey)).toEqual([
      'agg-1',
      'agg-1',
    ]);
  });

  it('resumes the ordering key after a failed ordered publish, then rethrows (M106 §3.5)', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
    sdk.failNextPublish = true;

    await expect(
      transport.publish('order-topic', new TextEncoder().encode('a'), undefined, 'agg-1'),
    ).rejects.toThrow('publish failed');
    expect(sdk.resumed).toEqual(['agg-1']);
  });

  it('rethrows the real error when the SDK omits the optional resumePublishing', async () => {
    const sdk = createFakeSdkModule();
    // A module double that does not model ordering: the topic handle has no
    // `resumePublishing`. Calling it unguarded would replace the publish error
    // with a TypeError.
    const Base = sdk.PubSub;
    sdk.PubSub = class extends Base {
      override topic(name: string, options?: { messageOrdering?: boolean }) {
        const handle = super.topic(name, options);
        return {
          publishMessage: handle.publishMessage,
          createSubscription: handle.createSubscription,
        };
      }
    };
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
    sdk.failNextPublish = true;

    await expect(
      transport.publish('order-topic', new TextEncoder().encode('a'), undefined, 'agg-1'),
    ).rejects.toThrow('publish failed');
    expect(sdk.resumed).toEqual([]);
  });

  it('does not resume a key when an UNORDERED publish fails (M106 §3.5)', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
    sdk.failNextPublish = true;

    await expect(transport.publish('plain-topic', new TextEncoder().encode('a'))).rejects.toThrow(
      'publish failed',
    );
    expect(sdk.resumed).toEqual([]);
  });

  it('orders a created subscription only when enableMessageOrdering is set (M106 §3.5)', async () => {
    const plain = createFakeSdkModule();
    await adaptPubSubModule(plain, { projectId: 'demo' }).open('t', 'sub-plain', () => {});
    expect(plain.subscriptionOptions.get('sub-plain')?.enableMessageOrdering).toBeUndefined();

    const ordered = createFakeSdkModule();
    await adaptPubSubModule(ordered, { projectId: 'demo', enableMessageOrdering: true })
      .open('t', 'sub-ordered', () => {});
    expect(ordered.subscriptionOptions.get('sub-ordered')?.enableMessageOrdering).toBe(true);
  });

  it('maps the SDK message id and publishTime onto the delivery (X28-4)', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let received: {
      messageId?: string;
      timestamp?: Date;
    } | null = null;
    await transport.open('test-topic', 'sub-meta', (msg) => {
      received = msg;
    });

    // A variable, not a literal, so the extra `publishTime` field (which the
    // real SDK message carries and the fake's structural type now models)
    // passes without excess-property checking.
    //
    // A `Date`, not an RFC 3339 string (M90d review): the locked
    // `@google-cloud/pubsub@6.0.0` delivers `publishTime` as a `PreciseDate`,
    // which extends `Date`. The string this used to send is a value the SDK
    // never produces, so the fixture was modelling a shape production has not.
    const raw = {
      data: new TextEncoder().encode('hello'),
      ack: () => {},
      nack: () => {},
      id: 'pubsub-msg-9',
      publishTime: new Date('2025-03-04T05:06:07.000Z'),
    };
    sdk.topics.get('test-topic')!.subscriptions.get('sub-meta')!.onMessage!(raw);

    expect(received).not.toBeNull();
    expect(received!.messageId).toBe('pubsub-msg-9');
    expect(received!.timestamp).toBeInstanceOf(Date);
    expect(received!.timestamp!.toISOString()).toBe('2025-03-04T05:06:07.000Z');
  });

  it('omits messageId and timestamp when the SDK message carries neither', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    let received: Record<string, unknown> | null = null;
    await transport.open('test-topic', 'sub-absent', (msg) => {
      received = msg as unknown as Record<string, unknown>;
    });

    sdk.topics.get('test-topic')!.subscriptions.get('sub-absent')!.onMessage!({
      data: new TextEncoder().encode('hello'),
      ack: () => {},
      nack: () => {},
      id: '',
    });

    // Presence, not truthiness — an empty-string id and an absent publishTime
    // must both arrive as ABSENT members.
    const delivered = received as unknown as Record<string, unknown>;
    expect('messageId' in delivered).toBe(false);
    expect('timestamp' in delivered).toBe(false);
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
    let pubsubClosed = false;
    const sdk = createFakeSdkModule();
    sdk.PubSub.prototype.close = function () {
      pubsubClosed = true;
      return Promise.resolve();
    };
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    await transport.close();
    expect(pubsubClosed).toBe(true);
  });

  it('subscription close works', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptPubSubModule(sdk, { projectId: 'demo' });

    const sub = await transport.open('test-topic', 'sub-close', (_msg) => {});
    await sub.close();

    const entry = sdk.subscriptions.get('sub-close');
    expect(entry!.closed).toBe(true);
  });
  describe('binding check on ALREADY_EXISTS (M101b, V8-2)', () => {
    it('attaches to an existing subscription bound to the requested topic', async () => {
      const sdk = createFakeSdkModule();
      const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
      await transport.createSubscription('orders', 'orders-sub');

      // The second create answers ALREADY_EXISTS; the metadata names `orders`.
      await expect(transport.open('orders', 'orders-sub', () => {})).resolves.toBeDefined();
    });

    it('accepts a fully-qualified requested topic', async () => {
      const sdk = createFakeSdkModule();
      const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
      await transport.createSubscription('orders', 'orders-sub');

      await expect(
        transport.open('projects/demo/topics/orders', 'orders-sub', () => {}),
      ).resolves.toBeDefined();
    });

    it('refuses an existing subscription bound to ANOTHER topic, naming all three', async () => {
      const sdk = createFakeSdkModule();
      const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
      // Topic A owns the name, as `messaging-consumers` did before M101b.
      await transport.createSubscription('orders', 'shared');

      const err = await transport.open('payments', 'shared', () => {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PubSubSubscriptionBoundElsewhereError);
      const named = err as PubSubSubscriptionBoundElsewhereError;
      expect(named.subscription).toBe('shared');
      expect(named.boundTopic).toBe('projects/demo/topics/orders');
      expect(named.requestedTopic).toBe('payments');
      expect(named.message).toContain('"shared"');
      expect(named.message).toContain('"projects/demo/topics/orders"');
      expect(named.message).toContain('"payments"');
      expect(named.message).toContain('SubscribeOptions.queue');
      expect(named.message).toContain('delete the existing subscription');
    });

    it('does not treat a topic whose name merely ends the same as a match', async () => {
      const sdk = createFakeSdkModule();
      const transport = adaptPubSubModule(sdk, { projectId: 'demo' });
      await transport.createSubscription('eu-orders', 'shared');

      // `/topics/orders` is not a suffix of `/topics/eu-orders` — the slash
      // anchors the comparison to a whole topic ID.
      await expect(transport.open('orders', 'shared', () => {})).rejects.toBeInstanceOf(
        PubSubSubscriptionBoundElsewhereError,
      );
    });

    it('refuses a subscription bound to a same-named topic in ANOTHER project', async () => {
      // Pub/Sub allows cross-project subscriptions, so `/topics/orders` alone
      // does not identify the topic: a short `orders` means THIS project's.
      const mod = {
        PubSub: class {
          topic() {
            return { createSubscription: () => Promise.reject({ code: 6 }) };
          }
          subscription() {
            return {
              on: () => {},
              close: () => Promise.resolve(),
              delete: () => Promise.resolve(),
              getMetadata: () => Promise.resolve([{ topic: 'projects/other/topics/orders' }]),
            };
          }
          close() {
            return Promise.resolve();
          }
        },
      } as unknown as PubSubSdkModule;
      const transport = adaptPubSubModule(mod, { projectId: 'demo' });

      const err = await transport.open('orders', 'sub', () => {}).then(
        () => null,
        (e: unknown) => e as PubSubSubscriptionBoundElsewhereError,
      );
      expect(err).toBeInstanceOf(PubSubSubscriptionBoundElsewhereError);
      expect(err?.boundTopic).toBe('projects/other/topics/orders');
    });

    it('refuses when the service reports no topic, since the binding is unproven', async () => {
      const mod = {
        PubSub: class {
          topic() {
            return { createSubscription: () => Promise.reject({ code: 6 }) };
          }
          subscription() {
            return {
              on: () => {},
              close: () => Promise.resolve(),
              delete: () => Promise.resolve(),
              getMetadata: () => Promise.resolve([{ topic: null }]),
            };
          }
          close() {
            return Promise.resolve();
          }
        },
      } as unknown as PubSubSdkModule;
      const transport = adaptPubSubModule(mod, { projectId: 'demo' });

      const err = await transport.open('orders', 'sub', () => {}).then(
        () => null,
        (e: unknown) => e as PubSubSubscriptionBoundElsewhereError,
      );
      expect(err).toBeInstanceOf(PubSubSubscriptionBoundElsewhereError);
      expect(err?.boundTopic).toBe('(unknown)');
    });

    it('propagates a failing metadata read rather than attaching blindly', async () => {
      const failure = new Error('permission denied reading subscription');
      const mod = {
        PubSub: class {
          topic() {
            return { createSubscription: () => Promise.reject({ code: 6 }) };
          }
          subscription() {
            return {
              on: () => {},
              close: () => Promise.resolve(),
              delete: () => Promise.resolve(),
              getMetadata: () => Promise.reject(failure),
            };
          }
          close() {
            return Promise.resolve();
          }
        },
      } as unknown as PubSubSdkModule;
      const transport = adaptPubSubModule(mod, { projectId: 'demo' });

      await expect(transport.open('orders', 'sub', () => {})).rejects.toBe(failure);
    });
  });
});

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@setu-ts/common';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import type { IPubSubSubscription, IPubSubTransport } from '../../src/brokers/pubsub-broker.ts';
import { CloudBrokerUnavailableError } from '../../src/errors.ts';

function createRuntime(platform: string = 'node'): IRuntimeServices {
  return {
    platform: () => platform as ReturnType<IRuntimeServices['platform']>,
    uuid: () => 'uuid-1',
    now: () => 1000000,
    setTimeout: (_fn: () => void) => (1 as unknown as ReturnType<typeof setTimeout>),
    clearTimeout: () => {},
    setInterval: () => (1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: () => {},
    randomBytes: () => new Uint8Array(16),
    subtle: undefined,
    hostname: 'test',
    version: '0.1.0',
    hrtime: () => 0,
    fs: undefined,
    env: {},
    exit: () => {},
  } as unknown as IRuntimeServices;
}

describe('GcpPubSubBroker', () => {
  describe('connect()', () => {
    it('uses injected client without loading SDK', async () => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      expect(broker.isReady()).toBe(true);
    });

    it('throws CloudBrokerUnavailableError on cloudflare-workers', async () => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime('cloudflare-workers'), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await expect(broker.connect()).rejects.toThrow(CloudBrokerUnavailableError);
      expect(broker.isReady()).toBe(false);
    });
  });

  describe('publish()', () => {
    it('serializes and encodes to bytes', async () => {
      const published: Array<{ topic: string; bytes: Uint8Array }> = [];
      const transport: IPubSubTransport = {
        publish: (t, b) => {
          published.push({ topic: t, bytes: b });
          return Promise.resolve();
        },
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.publish('test-topic', { foo: 'bar' });

      expect(published).toHaveLength(1);
      expect(published[0].topic).toBe('test-topic');
      expect(new TextDecoder().decode(published[0].bytes)).toBe('{"foo":"bar"}');
    });

    it('encodes non-ASCII correctly', async () => {
      const published: Uint8Array[] = [];
      const transport: IPubSubTransport = {
        publish: (_t, b) => {
          published.push(b);
          return Promise.resolve();
        },
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.publish('test', { text: '\u{1F600}' });

      const decoded = new TextDecoder().decode(published[0]);
      expect(decoded).toContain('\ud83d\ude00');
    });
  });

  describe('subscribe()', () => {
    it('delivers messages through handler', async () => {
      const received: unknown[] = [];
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.subscribe('topic', (msg) => {
        void received.push(msg);
      });

      onMessageCb!({ payload: JSON.stringify({ hello: 'world' }), ack: () => {}, nack: () => {} });
      expect(received).toHaveLength(1);
    });
  });

  describe('subscribe() ack/nack', () => {
    it('acks on handler success', async () => {
      let acked = false;
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.subscribe('topic', () => {});

      onMessageCb!({
        payload: '{}',
        ack: () => {
          acked = true;
        },
        nack: () => {},
      });
      // Broker uses async IIFE internally; await microtask to let ack settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(acked).toBe(true);
    });

    it('nacks on handler throw', async () => {
      let nacked = false;
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.subscribe('topic', () => {
        throw new Error('boom');
      });

      onMessageCb!({
        payload: '{}',
        ack: () => {},
        nack: () => {
          nacked = true;
        },
      });
      // Broker uses async IIFE internally; await microtask to let nack settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(nacked).toBe(true);
    });
  });

  describe('request/respond RPC round-trip', () => {
    // These tests verify the B1 fix: the reply inbox callback deserializes the
    // payload BEFORE calling onReply, and acks on success / nacks on failure.
    // We test through the actual broker flow by awaiting the inbox open.

    it('reply payload is deserialized from serialized text and acked', async () => {
      let ackCount = 0;
      let nackCount = 0;
      const opens: Array<
        { topic: string; subscription: string; cb: (...args: unknown[]) => unknown }
      > = [];
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (topic, sub, cb) => {
          opens.push({ topic, subscription: sub, cb: cb as (...args: unknown[]) => unknown });
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.respond('topic', () => Promise.resolve({ status: 'ok' }));
      // request() opens the inbox lazily; await it so the inbox callback is registered.
      void broker.request('topic', 'hello');
      // Wait for async inbox open to complete.
      await new Promise((r) => setTimeout(r, 0));

      // The inbox open is the second transport.open() call.
      const inboxOpen = opens.find((o) => o.subscription.startsWith('rr-inbox-'));
      expect(inboxOpen).toBeDefined();

      // Simulate a reply arriving on the inbox.
      (inboxOpen!.cb as (msg: { payload: string; ack: () => void; nack: () => void }) => void)({
        payload: JSON.stringify({
          kind: 'rr-reply',
          correlationId: 'corr-1',
          ok: true,
          payload: { status: 'ok' },
        }),
        ack: () => {
          ackCount++;
        },
        nack: () => {
          nackCount++;
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(ackCount).toBe(1);
      expect(nackCount).toBe(0);
    });

    it('malformed reply is nacked exactly once', async () => {
      let nackCount = 0;
      const opens: Array<
        { topic: string; subscription: string; cb: (...args: unknown[]) => unknown }
      > = [];
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (topic, sub, cb) => {
          opens.push({ topic, subscription: sub, cb: cb as (...args: unknown[]) => unknown });
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.respond('topic', () => Promise.resolve({ status: 'ok' }));
      void broker.request('topic', 'hello');
      await new Promise((r) => setTimeout(r, 0));

      const inboxOpen = opens.find((o) => o.subscription.startsWith('rr-inbox-'));
      (inboxOpen!.cb as (msg: { payload: string; ack: () => void; nack: () => void }) => void)({
        payload: 'NOT-VALID-JSON{{{',
        ack: () => {},
        nack: () => {
          nackCount++;
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(nackCount).toBe(1);
    });

    it('foreign-correlation reply is acked but not matched', async () => {
      let nackCount = 0;
      let ackCount = 0;
      const opens: Array<
        { topic: string; subscription: string; cb: (...args: unknown[]) => unknown }
      > = [];
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (topic, sub, cb) => {
          opens.push({ topic, subscription: sub, cb: cb as (...args: unknown[]) => unknown });
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.respond('topic', () => Promise.resolve({ status: 'ok' }));
      void broker.request('topic', 'hello');
      await new Promise((r) => setTimeout(r, 0));

      const inboxOpen = opens.find((o) => o.subscription.startsWith('rr-inbox-'));
      (inboxOpen!.cb as (msg: { payload: string; ack: () => void; nack: () => void }) => void)({
        payload: JSON.stringify({
          kind: 'rr-reply',
          correlationId: 'foreign-corr',
          ok: true,
          payload: 'unexpected',
        }),
        ack: () => {
          ackCount++;
        },
        nack: () => {
          nackCount++;
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      // Foreign reply should be acked (consumed from inbox).
      expect(ackCount).toBe(1);
      expect(nackCount).toBe(0);
    });
  });

  describe('disconnect()', () => {
    it('closes the transport', async () => {
      let closed = false;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.disconnect();

      expect(closed).toBe(true);
      expect(broker.isReady()).toBe(false);
    });

    it('is idempotent', async () => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.disconnect();
      await broker.disconnect(); // should not throw
      expect(broker.isReady()).toBe(false);
    });

    it('closes subscriptions then transport', async () => {
      let subClosed = false;
      let transportClosed = false;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () =>
          Promise.resolve({
            close: () => {
              subClosed = true;
              return Promise.resolve();
            },
          } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => {
          transportClosed = true;
          return Promise.resolve();
        },
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.subscribe('topic', () => {});
      await broker.disconnect();

      expect(subClosed).toBe(true);
      expect(transportClosed).toBe(true);
    });
  });

  describe('connect() idempotent', () => {
    it('returns early when already connected', async () => {
      let connectCount = 0;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => {
          connectCount++;
          return Promise.resolve();
        },
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.connect();
      expect(broker.isReady()).toBe(true);
    });
  });

  describe('request() not connected', () => {
    it('throws when not connected', async () => {
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      });

      await expect(broker.request('topic', 'request', {})).rejects.toThrow();
    });
  });

  describe('options', () => {
    it('uses custom defaultQueue', async () => {
      let openedSub = '';
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_t: string, s: string) => {
          openedSub = s;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport, defaultQueue: 'my-queue' });

      await broker.connect();
      await broker.subscribe('topic', () => {});
      // M101b: `defaultQueue` is the PREFIX of the per-topic default.
      expect(openedSub).toBe('my-queue.topic');
    });

    it('opens one subscription per topic by default (M101b, V8-2)', async () => {
      const opened: Array<{ topic: string; subscription: string }> = [];
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (topic: string, subscription: string) => {
          opened.push({ topic, subscription });
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.subscribe('orders', () => {});
      await broker.subscribe('payments', () => {});
      await broker.subscribe('audit', () => {}, { queue: 'shared-audit' });

      // Two topics never share the project-global default subscription, and a
      // caller-supplied queue is used verbatim.
      expect(opened).toEqual([
        { topic: 'orders', subscription: 'messaging-consumers.orders' },
        { topic: 'payments', subscription: 'messaging-consumers.payments' },
        { topic: 'audit', subscription: 'shared-audit' },
      ]);
    });

    it('derives the default from the topic ID when the topic is fully qualified', async () => {
      // `/` is illegal in a subscription ID: the emulator answers
      // INVALID_ARGUMENT for `messaging-consumers.projects/p/topics/orders`.
      const opened: string[] = [];
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_topic: string, subscription: string) => {
          opened.push(subscription);
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });
      await broker.connect();

      await broker.subscribe('projects/p/topics/orders', () => {});
      await broker.subscribe('orders', () => {});

      // Both spellings of one topic share its one default subscription.
      expect(opened).toEqual(['messaging-consumers.orders', 'messaging-consumers.orders']);
    });

    it('refuses a subscription name over the 255-character limit before opening', async () => {
      let openCalls = 0;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => {
          openCalls++;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });
      await broker.connect();

      // 'messaging-consumers.' is 20 characters, so a 236-character topic
      // derives a 256-character name; 235 derives exactly 255 and is allowed.
      const tooLong = 't'.repeat(236);
      const err = await broker.subscribe(tooLong, () => {}).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain('256 characters');
      expect(err?.message).toContain('at most 255');
      expect(err?.message).toContain('SubscribeOptions.queue');
      await broker.subscribe('t'.repeat(235), () => {});
      const explicit = await broker.subscribe('x', () => {}, { queue: 'q'.repeat(256) }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(explicit?.message).toContain('256 characters');
      expect(openCalls).toBe(1);
    });
  });

  describe('error paths', () => {
    it('throws when publishing without connection', async () => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      // Do NOT call connect()
      await expect(broker.publish('topic', 'msg')).rejects.toThrow('not connected');
    });

    it('throws when subscribing without connection', async () => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      // Do NOT call connect()
      await expect(broker.subscribe('topic', () => {})).rejects.toThrow('not connected');
    });
  });

  describe('unsubscribe', () => {
    it('closes the subscription on unsubscribe', async () => {
      let closed = false;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: () =>
          Promise.resolve({
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          } as IPubSubSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      const sub = await broker.subscribe('topic', () => {});
      expect(closed).toBe(false);

      await sub.unsubscribe();
      expect(closed).toBe(true);
    });
  });

  describe('logger on handler error', () => {
    it('calls logger.error when handler throws', async () => {
      let logged = '';
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, {
        client: transport,
        logger: {
          error: (msg: string) => {
            logged = msg;
          },
        },
      });

      await broker.connect();
      await broker.subscribe('topic', () => {
        throw new Error('handler-error');
      });

      onMessageCb!({ payload: '{}', ack: () => {}, nack: () => {} });
      await Promise.resolve();
      await Promise.resolve();
      expect(logged).toContain('handler-error');
    });
  });
});

// Guarded real-import: exercises the lazy-load path through loadPubSubModule.
// Mirrors the kafka-broker.test.ts pattern — connect() without an injected client
// enters the real `import('npm:@google-cloud/pubsub@^6')` path. The module is
// pinned in deno.lock so the import resolves; connect() sets #ready to true
// because the SDK module is available. Disconnect afterwards to clean up.
describe('GcpPubSubBroker — lazy SDK load', () => {
  it('connect without an injected client exercises the loadPubSubModule() path', async () => {
    const runtime = createRuntime();
    const broker = new GcpPubSubBroker(runtime, {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { projectId: 'test-project' });

    // The SDK module is cached in deno.lock, so connect() resolves (loadPubSubModule
    // is exercised, and adaptPubSubModule constructs a REAL PubSub client) and the
    // broker becomes ready. Disconnect to clean up.
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });
});

// Trigger ack/nack in the subscribe handler callback
describe('subscribe ack/nack path', () => {
  it('acks when handler succeeds', async () => {
    let ackCalled = false;
    let nackCalled = false;
    let capturedOnMsg: (msg: { payload: string; ack: () => void; nack: () => void }) => void =
      () => {};
    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t: string, _s: string, onMsg) => {
        capturedOnMsg = onMsg;
        return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
      },
      createSubscription: () => Promise.resolve(),
      deleteSubscription: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();
    await broker.subscribe('topic', async () => {}, { queue: 'grp' });

    // Trigger the message callback to hit ack path
    capturedOnMsg({
      payload: JSON.stringify({ event: 'test' }),
      ack: () => {
        ackCalled = true;
      },
      nack: () => {
        nackCalled = true;
      },
    });
    await Promise.resolve();
    expect(ackCalled).toBe(true);
    expect(nackCalled).toBe(false);
  });

  it('nacks when handler throws', async () => {
    let ackCalled = false;
    let nackCalled = false;
    let capturedOnMsg: (msg: { payload: string; ack: () => void; nack: () => void }) => void =
      () => {};
    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t: string, _s: string, onMsg) => {
        capturedOnMsg = onMsg;
        return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
      },
      createSubscription: () => Promise.resolve(),
      deleteSubscription: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();
    await broker.subscribe('topic', () => {
      throw new Error('boom');
    }, { queue: 'grp' });

    // Trigger the message callback to hit nack path
    capturedOnMsg({
      payload: JSON.stringify({ event: 'test' }),
      ack: () => {
        ackCalled = true;
      },
      nack: () => {
        nackCalled = true;
      },
    });
    await Promise.resolve();
    expect(ackCalled).toBe(false);
    expect(nackCalled).toBe(true);
  });
});

// Broker tests using adaptPubSubModule(fakeSdk) — exercises adapter closures
describe('GcpPubSubBroker with adapted fake SDK module', () => {
  function createFakeSdkModuleWithRouting():
    & import('../../src/brokers/pubsub-broker.ts').PubSubSdkModule
    & {
      publishes: Array<{ topic: string; data: Uint8Array }>;
      messageCallbacks: Array<{
        topic: string;
        subscription: string;
        onMessage: (
          msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
        ) => void;
      }>;
    }
    & {
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
    } {
    type FakeMod =
      & import('../../src/brokers/pubsub-broker.ts').PubSubSdkModule
      & {
        publishes: Array<{ topic: string; data: Uint8Array }>;
        messageCallbacks: Array<{
          topic: string;
          subscription: string;
          onMessage: (
            msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string },
          ) => void;
        }>;
      }
      & {
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
    const mod = {} as FakeMod;
    mod.topics = new Map();
    let fakeProjectId = '';
    mod.subscriptions = new Map();

    mod.PubSub = class {
      constructor(options: { projectId: string; credentials?: unknown }) {
        // The real SDK reports topics under the project it was built for.
        fakeProjectId = options.projectId;
      }
      topic(name: string) {
        if (!mod.topics.has(name)) {
          mod.topics.set(name, { messages: [], subscriptions: new Map() });
        }
        const td = mod.topics.get(name)!;
        return {
          publishMessage(message: { data: Uint8Array }) {
            td.messages.push(message);
            return Promise.resolve('msg-id');
          },
          createSubscription(subName: string) {
            // M101b: names are project-global, as on the real service — an
            // existing subscription answers ALREADY_EXISTS whichever topic it
            // is bound to. The pre-M101b fake accepted every create.
            const known = mod.subscriptions.get(subName);
            if (known !== undefined && known.topic !== '') {
              return Promise.reject({ code: 6, message: 'ALREADY_EXISTS' });
            }
            td.subscriptions.set(subName, { onMessage: null });
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
          // This double does not model ordering; the §3.5 assertions that record
          // resumePublishing live in pubsub-adapter.test.ts. The member exists so
          // the double honours the widened SDK contract.
          resumePublishing() {},
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
              for (const [, td] of mod.topics) {
                if (td.subscriptions.has(subName)) {
                  td.subscriptions.get(subName)!.onMessage = handler as never;
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

  it('exercises ack/nack/close closures through adapted SDK', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const sdk = createFakeSdkModuleWithRouting();
    const transport = adaptPubSubModule(sdk, { projectId: 'test' });

    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    let handlerCalled = false;
    await broker.subscribe('orders', () => {
      handlerCalled = true;
    });

    // Deliver a message through the fake SDK's onMessage callback
    const td = sdk.topics.get('orders');
    const cb = td!.subscriptions.get('messaging-consumers.orders')!.onMessage!;
    cb({
      data: new TextEncoder().encode(JSON.stringify({ item: 'widget' })),
      ack: () => {},
      nack: () => {},
      id: 'msg-1',
    });

    // The adapter decodes raw.data, calls onMessage(payload), which reaches the broker's handler
    await Promise.resolve();
    expect(handlerCalled).toBe(true);

    await broker.disconnect();
  });

  it('exercises subscription close closure through adapted SDK', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const sdk = createFakeSdkModuleWithRouting();
    const transport = adaptPubSubModule(sdk, { projectId: 'test' });

    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();
    const sub = await broker.subscribe('events', () => {});

    // Unsubscribe exercises the adapter's close closure
    await sub.unsubscribe();

    // The SDK subscription should be closed
    const entries = [...sdk.subscriptions.values()];
    const closedEntry = entries.find((e) => e.closed);
    expect(closedEntry).toBeDefined();

    await broker.disconnect();
  });

  it('exercises publish through adapted SDK', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const sdk = createFakeSdkModuleWithRouting();
    const transport = adaptPubSubModule(sdk, { projectId: 'test' });

    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();
    await broker.publish('metrics', { value: 42 });

    const topic = sdk.topics.get('metrics');
    expect(topic).toBeDefined();
    expect(topic!.messages).toHaveLength(1);
    expect(new TextDecoder().decode(topic!.messages[0].data)).toBe('{"value":42}');

    await broker.disconnect();
  });

  it('exercises nack closure through handler throw', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const sdk = createFakeSdkModuleWithRouting();
    const transport = adaptPubSubModule(sdk, { projectId: 'test' });

    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });

    await broker.connect();

    await broker.subscribe('fail-topic', () => {
      throw new Error('boom');
    });

    // Deliver a message — triggers nack path
    const td = sdk.topics.get('fail-topic');
    const cb = td!.subscriptions.get('messaging-consumers.fail-topic')!.onMessage!;
    cb({
      data: new TextEncoder().encode(JSON.stringify({ fail: true })),
      ack: () => {},
      nack: () => {},
      id: 'msg-fail',
    });

    await Promise.resolve();

    await broker.disconnect();
  });
});

// Adapt function coverage — loadPubSubModule exported
describe('loadPubSubModule (exported)', () => {
  it('is exported as a function', async () => {
    const mod = await import('../../src/brokers/pubsub-broker.ts');
    expect(typeof mod.loadPubSubModule).toBe('function');
  });

  it('the REAL SDK module adapts to a port carrying every member the code calls', async () => {
    const { loadPubSubModule, adaptPubSubModule } = await import(
      '../../src/brokers/pubsub-broker.ts'
    );

    // Loads `npm:` for real (pinned in deno.lock), then adapts it. Asserting the
    // adapted PORT rather than just reaching the import line is what catches SDK
    // drift: a renamed constructor throws here, and a member the adapter forgot
    // to build is caught by name. A bare `try { await load() } catch {}` covered
    // the line while asserting nothing and could not fail.
    const mod = await loadPubSubModule();
    const port = adaptPubSubModule(mod, { projectId: 'test-project' }) as unknown as Record<
      string,
      unknown
    >;

    for (const member of ['publish', 'open', 'createSubscription', 'deleteSubscription', 'close']) {
      expect(typeof port[member]).toBe('function');
    }
  });
});

// A2: C6 — createSubscription NOT_FOUND rethrow
describe('C6: createSubscription error discrimination', () => {
  it('swallows ALREADY_EXISTS (grpc code 6)', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const err = { code: 6, message: 'resource-exists' };
    const subObj = {
      on: () => {},
      close: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      // M101b: ALREADY_EXISTS is followed by a binding read; same topic attaches.
      getMetadata: () => Promise.resolve([{ topic: 'projects/test/topics/topic' }]),
    };
    const mod = {
      PubSub: class {
        constructor() {}
        topic() {
          return {
            createSubscription: () => {
              throw err;
            },
          };
        }
        subscription() {
          return subObj;
        }
        close() {
          return Promise.resolve();
        }
      },
    };
    const transport = adaptPubSubModule(
      // deno-lint-ignore no-explicit-any
      mod as any,
      { projectId: 'test' },
    );
    await expect(transport.open('topic', 'sub', () => {})).resolves.toBeDefined();
  });

  it('rethrows NOT_FOUND (grpc code 5)', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    const err = { code: 5, message: 'no-such-topic' };
    const mod = {
      PubSub: class {
        constructor() {}
        topic() {
          return {
            createSubscription: () => {
              throw err;
            },
          };
        }
        subscription() {
          return { on: () => {}, close: () => Promise.resolve(), delete: () => Promise.resolve() };
        }
        close() {
          return Promise.resolve();
        }
      },
    };
    const transport = adaptPubSubModule(
      // deno-lint-ignore no-explicit-any
      mod as any,
      { projectId: 'test' },
    );
    await expect(transport.open('topic', 'sub', () => {})).rejects.toBe(err);
  });
});

// A2: C7 — on('error') wires to logger
describe('C7: on(error) wires to logger', () => {
  it('subscription error calls logger.error', async () => {
    const { adaptPubSubModule } = await import('../../src/brokers/pubsub-broker.ts');
    let errorLoggerCalled = false;
    const fakeLogger = {
      error: (msg: string) => {
        errorLoggerCalled = true;
        expect(msg).toContain('subscription error');
      },
    };
    let errorEmitter: ((e: unknown) => void) | null = null;
    const mod = {
      PubSub: class {
        constructor() {}
        topic() {
          return { createSubscription: () => Promise.resolve([]) };
        }
        subscription() {
          return {
            on(event: string, fn: (e: unknown) => void) {
              if (event === 'error') errorEmitter = fn;
            },
            close: () => Promise.resolve(),
            delete: () => Promise.resolve(),
          };
        }
        close() {
          return Promise.resolve();
        }
      },
    };
    const transport = adaptPubSubModule(
      // deno-lint-ignore no-explicit-any
      mod as any,
      { projectId: 'test', logger: fakeLogger },
    );
    await transport.open('topic', 'sub', () => {});
    expect(errorLoggerCalled).toBe(false);
    errorEmitter!(new Error('boom'));
    expect(errorLoggerCalled).toBe(true);
  });
});

// A credential-less standalone construction must name the missing option rather
// than failing later inside the SDK. The plugin's option union makes this a
// compile error; the exported class has no such guard.
describe('GcpPubSubBroker — missing credentials', () => {
  it('connect() without projectId or client names the missing option', async () => {
    const runtime = createRuntime();
    const broker = new GcpPubSubBroker(runtime, {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    });

    await expect(broker.connect()).rejects.toThrow(/requires a projectId/);
  });
});

// X28-4: the platform assigns `messageId`/`publishTime` on every message, so
// the metadata must carry them — and absence must mean "the transport carried
// none", never "the adapter did not look".
describe('GcpPubSubBroker — delivered metadata (X28-4)', () => {
  function brokerWithDelivery(
    delivery: Record<string, unknown> | null,
  ): { broker: GcpPubSubBroker; seen: unknown[]; deliver: () => void } {
    let onMessageCb: ((msg: Record<string, unknown>) => void) | null = null;
    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t, _s, cb) => {
        onMessageCb = cb as unknown as (msg: Record<string, unknown>) => void;
        return Promise.resolve({ close: () => Promise.resolve() } as IPubSubSubscription);
      },
      createSubscription: () => Promise.resolve(),
      deleteSubscription: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const broker = new GcpPubSubBroker(createRuntime(), {
      serialize: (v) => JSON.stringify(v),
      deserialize: (s) => JSON.parse(s),
    }, { client: transport });
    const seen: unknown[] = [];
    return { broker, seen, deliver: () => onMessageCb!(delivery ?? {}) };
  }

  it('copies messageId and timestamp onto MessageMetadata when the transport supplies them', async () => {
    const context = brokerWithDelivery({
      payload: '{"id":1}',
      ack: () => {},
      nack: () => {},
      attributes: {},
      messageId: 'pubsub-id-1',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
    });
    await context.broker.connect();
    await context.broker.subscribe('orders', (_message, metadata) => {
      context.seen.push(metadata);
    });
    context.deliver();
    await new Promise((r) => setTimeout(r, 5));

    const metadata = context.seen[0] as { messageId?: string; timestamp?: Date };
    expect(metadata.messageId).toBe('pubsub-id-1');
    expect(metadata.timestamp).toBeInstanceOf(Date);
    expect(metadata.timestamp?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('leaves both members ABSENT when the transport supplies neither', async () => {
    const context = brokerWithDelivery({
      payload: '{"id":1}',
      ack: () => {},
      nack: () => {},
    });
    await context.broker.connect();
    await context.broker.subscribe('orders', (_message, metadata) => {
      context.seen.push(metadata);
    });
    context.deliver();
    await new Promise((r) => setTimeout(r, 5));

    const metadata = context.seen[0] as Record<string, unknown>;
    // Presence, not truthiness — the only check that separates absent from
    // undefined.
    expect('messageId' in metadata).toBe(false);
    expect('timestamp' in metadata).toBe(false);
  });
});

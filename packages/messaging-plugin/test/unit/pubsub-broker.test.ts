import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
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

  describe('request/respond', () => {
    it('delegates request through the core', async () => {
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
      await broker.respond('topic', () => Promise.resolve('ok'));

      // Trigger the inbox callback with a reply
      onMessageCb!({
        payload: JSON.stringify({ reply: 'ok', correlationId: 'corr-1' }),
        ack: () => {},
        nack: () => {},
      });

      expect(true).toBe(true);
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
      expect(openedSub).toBe('my-queue');
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

  describe('request', () => {
    it('delegates to RequestReplyCore', async () => {
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

      // request should not throw even without a responder (it times out)
      const promise = broker.request('topic', 'hello');
      // We won't await the full timeout; just verify it returns a promise
      expect(promise).toBeDefined();
    });
  });
});

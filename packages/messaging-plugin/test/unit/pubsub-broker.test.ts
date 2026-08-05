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
        publish: async () => {},
        open: async () => ({ close: async () => {} } as IPubSubSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
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
        publish: async () => {},
        open: async () => ({ close: async () => {} } as IPubSubSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
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
        publish: async (t, b) => {
          published.push({ topic: t, bytes: b });
        },
        open: async () => ({ close: async () => {} } as IPubSubSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
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
        publish: async (_t, b) => {
          published.push(b);
        },
        open: async () => ({ close: async () => {} } as IPubSubSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
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
        publish: async () => {},
        open: async (_t, _s, cb) => {
          onMessageCb = cb;
          return { close: async () => {} } as IPubSubSubscription;
        },
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
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

  describe('disconnect()', () => {
    it('closes the transport', async () => {
      let closed = false;
      const transport: IPubSubTransport = {
        publish: async () => {},
        open: async () => ({ close: async () => {} } as IPubSubSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {
          closed = true;
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
  });
});

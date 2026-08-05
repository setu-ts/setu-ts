import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type {
  IServiceBusSubscription,
  IServiceBusTransport,
} from '../../src/brokers/service-bus-broker.ts';
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

describe('ServiceBusBroker', () => {
  describe('connect()', () => {
    it('uses injected client', async () => {
      const transport: IServiceBusTransport = {
        send: async () => {},
        open: async () => ({ close: async () => {} } as IServiceBusSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      expect(broker.isReady()).toBe(true);
    });

    it('throws CloudBrokerUnavailableError on cloudflare-workers', async () => {
      const transport: IServiceBusTransport = {
        send: async () => {},
        open: async () => ({ close: async () => {} } as IServiceBusSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
      };
      const broker = new ServiceBusBroker(createRuntime('cloudflare-workers'), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await expect(broker.connect()).rejects.toThrow(CloudBrokerUnavailableError);
      expect(broker.isReady()).toBe(false);
    });
  });

  describe('publish()', () => {
    it('sends serialized body', async () => {
      const sent: Array<{ topic: string; body: string }> = [];
      const transport: IServiceBusTransport = {
        send: async (t, b) => {
          sent.push({ topic: t, body: b });
        },
        open: async () => ({ close: async () => {} } as IServiceBusSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.publish('topic', { foo: 'bar' });

      expect(sent).toHaveLength(1);
      expect(sent[0].topic).toBe('topic');
      expect(sent[0].body).toBe('{"foo":"bar"}');
    });
  });

  describe('subscribe()', () => {
    it('delivers messages through handler', async () => {
      const received: unknown[] = [];
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IServiceBusTransport = {
        send: async () => {},
        open: async (_t, _s, cb) => {
          onMessageCb = cb;
          return { close: async () => {} } as IServiceBusSubscription;
        },
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {},
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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
      const transport: IServiceBusTransport = {
        send: async () => {},
        open: async () => ({ close: async () => {} } as IServiceBusSubscription),
        createSubscription: async () => {},
        deleteSubscription: async () => {},
        close: async () => {
          closed = true;
        },
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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

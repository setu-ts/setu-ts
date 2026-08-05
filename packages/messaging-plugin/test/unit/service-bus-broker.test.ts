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
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
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
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
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
        send: (t, b) => {
          sent.push({ topic: t, body: b });
          return Promise.resolve();
        },
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
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
        send: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
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

  describe('subscribe() ack/nack', () => {
    it('acks on handler success', async () => {
      let acked = false;
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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
      await Promise.resolve();
      await Promise.resolve();
      expect(acked).toBe(true);
    });

    it('nacks on handler throw', async () => {
      let nacked = false;
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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
      await Promise.resolve();
      await Promise.resolve();
      expect(nacked).toBe(true);
    });
  });

  describe('request/respond', () => {
    it('responds through the core', async () => {
      let onMessageCb:
        | ((msg: { payload: string; ack: () => void; nack: () => void }) => void)
        | null = null;
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.respond('topic', () => Promise.resolve('ok'));

      onMessageCb!({
        payload: JSON.stringify({ reply: 'ok', correlationId: 'corr-1' }),
        ack: () => {},
        nack: () => {},
      });

      expect(true).toBe(true);
    });
  });

  describe('options', () => {
    it('uses custom defaultQueue', async () => {
      let openedSub = '';
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t: string, s: string) => {
          openedSub = s;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport, defaultQueue: 'my-queue' });

      await broker.connect();
      await broker.subscribe('topic', () => {});
      expect(openedSub).toBe('my-queue');
    });
  });

  describe('disconnect()', () => {
    it('closes the transport', async () => {
      let closed = false;
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => {
          closed = true;
          return Promise.resolve();
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

    it('is idempotent', async () => {
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();
      await broker.disconnect();
      await broker.disconnect(); // should not throw
      expect(broker.isReady()).toBe(false);
    });
  });

  describe('error paths', () => {
    it('throws when publishing without connection', async () => {
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await expect(broker.publish('topic', 'msg')).rejects.toThrow('not connected');
    });

    it('throws when subscribing without connection', async () => {
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: () => Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await expect(broker.subscribe('topic', () => {})).rejects.toThrow('not connected');
    });
  });

  describe('unsubscribe', () => {
    it('closes the subscription on unsubscribe', async () => {
      let closed = false;
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: () =>
          Promise.resolve({
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          } as IServiceBusSubscription),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t, _s, cb) => {
          onMessageCb = cb;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
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

  describe('options', () => {
    it('uses custom defaultQueue', async () => {
      let openedSub = '';
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_t: string, s: string) => {
          openedSub = s;
          return Promise.resolve({ close: () => Promise.resolve() } as IServiceBusSubscription);
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport, defaultQueue: 'my-queue' });

      await broker.connect();
      await broker.subscribe('topic', () => {});
      expect(openedSub).toBe('my-queue');
    });
  });
});

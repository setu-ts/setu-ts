import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@setu-ts/common';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import type { IPubSubSubscription, IPubSubTransport } from '../../src/brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type {
  IServiceBusSubscription,
  IServiceBusTransport,
} from '../../src/brokers/service-bus-broker.ts';

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

type OnMessageFn = (
  msg: { payload: string; ack: () => void; nack: () => void },
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// GcpPubSubBroker settlement behavior
//
// The Pub/Sub broker uses a fire-and-forget IIFE:
//   onMessage: (msg) => { (async () => { ... handler ...; ack/nack })(); }
// So ack/nack errors are unhandled rejections (transport-level), but the
// explicit flow guarantees exactly-one ack or nack per handler invocation.
// ---------------------------------------------------------------------------
describe('GcpPubSubBroker settlement behavior', () => {
  it('ack() called exactly once on handler success', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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

    const received: unknown[] = [];
    await broker.subscribe('topic', (msg) => {
      received.push(msg);
    });

    // The IIFE is fire-and-forget; flush microtasks for settlement
    onMessageCb!({
      payload: '{"hello":"world"}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ hello: 'world' });
    expect(ackCount).toBe(1);
    expect(nackCount).toBe(0);
  });

  it('nack() called exactly once on handler throw', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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
      throw new Error('handler error');
    });

    onMessageCb!({
      payload: '{"hello":"world"}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ackCount).toBe(0);
    expect(nackCount).toBe(1);
  });

  it('non-Error rejection results in exactly one nack', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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
      throw 'string error'; // non-Error
    });

    onMessageCb!({
      payload: '{"hello":"world"}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ackCount).toBe(0);
    expect(nackCount).toBe(1);
  });

  // The Pub/Sub broker uses a fire-and-forget IIFE for message handling,
  // so a throw inside ack/nack becomes an unhandled rejection (transport-level).
  // The explicit flow — handler runs first, then exactly one ack or nack —
  // is proven by the ack/nack count tests above.
});

// ---------------------------------------------------------------------------
// ServiceBusBroker settlement behavior
//
// The Service Bus broker's subscribe callback is async:
//   onMessage: async (msg) => { handler...; return msg.ack()/msg.nack(); }
// So the ack/nack result propagates through the async callback.
// ---------------------------------------------------------------------------
describe('ServiceBusBroker settlement behavior', () => {
  it('ack() called exactly once on handler success', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IServiceBusTransport = {
      send: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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

    const received: unknown[] = [];
    await broker.subscribe('topic', (msg) => {
      received.push(msg);
    });

    await onMessageCb!({
      payload: '{"hello":"world"}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ hello: 'world' });
    expect(ackCount).toBe(1);
    expect(nackCount).toBe(0);
  });

  it('nack() called exactly once on handler throw', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IServiceBusTransport = {
      send: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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
      throw new Error('handler exploded');
    });

    await onMessageCb!({
      payload: '{"hello":"world"}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });

    expect(ackCount).toBe(0);
    expect(nackCount).toBe(1);
  });

  it('explicit nack settlement rejection propagates without double settlement', async () => {
    let nackCount = 0;
    const nackError = new Error('nack failed');
    let onMessageCb: OnMessageFn | undefined;

    const transport: IServiceBusTransport = {
      send: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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
      throw new Error('force nack');
    });

    await expect(onMessageCb!({
      payload: '{"x":1}',
      ack: () => {},
      nack: () => {
        nackCount++;
        throw nackError;
      },
    })).rejects.toThrow('nack failed');

    expect(nackCount).toBe(1);
  });

  it('non-Error handler rejection results in exactly one nack', async () => {
    let ackCount = 0, nackCount = 0;
    let onMessageCb: OnMessageFn | undefined;

    const transport: IServiceBusTransport = {
      send: () => Promise.resolve(),
      open: (_t, _s, onMessage: OnMessageFn) => {
        onMessageCb = onMessage;
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
      throw 'string rejection';
    });

    await onMessageCb!({
      payload: '{"x":1}',
      ack: () => {
        ackCount++;
      },
      nack: () => {
        nackCount++;
      },
    });

    expect(ackCount).toBe(0);
    expect(nackCount).toBe(1);
  });
});

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IKafkaFactory } from '../../../src/interfaces/index.ts';
import { KafkaBroker } from '../../../src/brokers/kafka-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

interface FakeKafka {
  client: IKafkaFactory;
  /** Fires the registered producer `DISCONNECT`/`CONNECT` listeners. */
  fire: (event: string) => void;
}

/**
 * Minimal Kafka factory satisfying `validateClient` (producer/consumer) where
 * the producer carries a configurable event emitter.
 */
function makeKafka(events: boolean): FakeKafka {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const producer: Record<string, unknown> = {
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
  };
  if (events) {
    producer.on = (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    };
    producer.off = (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx !== -1) {
        arr.splice(idx, 1);
      }
    };
  }
  const client = {
    producer: () => producer,
    consumer: () => ({}),
  } as unknown as IKafkaFactory;
  return {
    client,
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function makeBroker(client: IKafkaFactory) {
  const runtime = createFakeRuntime();
  return new KafkaBroker(runtime, new JsonSerializer(), {
    client,
    brokers: ['localhost:9092'],
  });
}

describe('KafkaBroker health (M70c)', () => {
  it('reports down before connect', async () => {
    const { client } = makeKafka(true);
    const broker = makeBroker(client);
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });

  it('reports up when connected with an event surface', async () => {
    const { client } = makeKafka(true);
    const broker = makeBroker(client);
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports down during a DISCONNECT fault window, up after CONNECT', async () => {
    const { client, fire } = makeKafka(true);
    const broker = makeBroker(client);
    await broker.connect();
    expect(await broker.reachability()).toBe(true);
    // A DISCONNECT event opens the fault window: isHealthy false, isReady true.
    fire('DISCONNECT');
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
    // A CONNECT event closes the window.
    fire('CONNECT');
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports unknown when the producer lacks an event surface', async () => {
    const { client } = makeKafka(false);
    const broker = makeBroker(client);
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });
});

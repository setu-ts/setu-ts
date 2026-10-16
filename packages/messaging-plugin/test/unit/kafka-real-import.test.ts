/**
 * Real-import test: the kafkajs producer event names (X28-1).
 *
 * Every other Kafka test injects a client, so nothing pinned the event names
 * against the real module — which is how the uppercase `events` map KEYS
 * reached `producer.on()` and the broker could never start. This file imports
 * the real kafkajs and asserts three things a fake cannot decide:
 *
 * 1. the real `producer.events.DISCONNECT` / `.CONNECT` values equal the
 *    broker's declared constants;
 * 2. a real producer ACCEPTS those wire values on `on()`;
 * 3. a real producer REJECTS the uppercase keys — the exact defect that
 *    shipped.
 *
 * Needs no broker: constructing a `Kafka` client and a producer is offline.
 */
import { describe, expect, it } from 'vitest';
import {
  KAFKA_PRODUCER_CONNECT,
  KAFKA_PRODUCER_DISCONNECT,
  kafkaHealthClientConfig,
} from '../../src/brokers/kafka-broker.ts';

describe('REAL kafkajs producer events (guarded)', () => {
  it('builds a dedicated short-timeout admin with the measured methods', async () => {
    const config = kafkaHealthClientConfig(['127.0.0.1:19092'], 'example');
    expect(config).toEqual({
      brokers: ['127.0.0.1:19092'],
      clientId: 'example-health',
      retry: { retries: 0 },
      requestTimeout: 1500,
      connectionTimeout: 1000,
    });
    const { Kafka } = await import('kafkajs');
    const admin = new Kafka(config).admin();
    for (const method of [
      'describeCluster',
      'fetchOffsets',
      'fetchTopicOffsets',
      'describeGroups',
    ] as const)
      expect(typeof admin[method]).toBe('function');
  });
  it('accepts the wire values the broker attaches, and rejects the uppercase keys', async () => {
    const kafkajs = await import('kafkajs');

    // The constants the broker attaches equal the real module's own values.
    const kafka = new kafkajs.Kafka({ clientId: 'm90d-real-import', brokers: ['localhost:9092'] });
    const producer = kafka.producer();
    const events = producer.events;
    expect(events.DISCONNECT).toBe(KAFKA_PRODUCER_DISCONNECT);
    expect(events.CONNECT).toBe(KAFKA_PRODUCER_CONNECT);
    expect(events.DISCONNECT).toBe('producer.disconnect');
    expect(events.CONNECT).toBe('producer.connect');

    // The wire values are ACCEPTED — attaching must not throw.
    const listener = (): void => {};
    producer.on(events.DISCONNECT, listener);
    producer.on(events.CONNECT, listener);

    // The uppercase KEYS are REJECTED — the defect's exact shape. The cast is
    // the point: kafkajs's own .d.ts refuses the key, and at runtime the
    // validator throws too. This assertion is what makes the pre-fix code
    // fail here.
    const keyName = 'DISCONNECT' as Parameters<typeof producer.on>[0];
    expect(() => producer.on(keyName, listener)).toThrow();
    const keyName2 = 'CONNECT' as Parameters<typeof producer.on>[0];
    expect(() => producer.on(keyName2, listener)).toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PublishOptions } from '@setu-ts/common';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { TracedBroker } from '../../src/tracing/traced-broker.ts';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import {
  PUBLISH_REQUIRE_ROUTE,
  ROUTED_PUBLISH_AVAILABLE,
} from '../../src/brokers/publish-options.ts';
import { UnroutableMessageError } from '../../src/errors.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { outboxHarness, row, recordingTelemetry } from '../fixtures/outbox.ts';

describe('RabbitMQ required-route publications', () => {
  it.each(['direct', 'traced', 'pipelined'] as const)(
    'preserves unroutable identity and private intent through %s',
    async (facade) => {
      const client = new FakeAmqpConnection({ returnMandatory: true });
      const inner = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      const broker =
        facade === 'direct'
          ? inner
          : facade === 'traced'
            ? new TracedBroker(inner, recordingTelemetry(), 'rabbitmq')
            : new PipelinedBroker(inner, []);
      await broker.connect();
      expect(broker[ROUTED_PUBLISH_AVAILABLE]).toBe(true);
      await broker.publish('unbound', { canary: 'payload-secret' });
      const options: PublishOptions & { [PUBLISH_REQUIRE_ROUTE]: true } = {
        [PUBLISH_REQUIRE_ROUTE]: true,
      };
      const failure = await broker
        .publish('unbound', { canary: 'payload-secret' }, options)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnroutableMessageError);
      expect((failure as Error).message).toContain('unbound');
      expect((failure as Error).message).not.toContain('payload-secret');
      const channel = await client.createChannel();
      const publishes = channel.calls.filter((call) => call.method === 'publish');
      expect(publishes[0]!.args[3]).not.toHaveProperty('mandatory');
      expect(publishes[1]!.args[3]).toMatchObject({
        mandatory: true,
        headers: { 'x-setu-disposition-id': expect.any(String) },
      });
      await broker.disconnect();
    },
  );
  it('never exposes disposition correlation to handlers', async () => {
    const client = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    const handler = vi.fn();
    await broker.subscribe('orders', handler);
    const channel = await client.createChannel();
    await channel.deliver('{}', {
      headers: { 'x-setu-disposition-id': 'private', application: 'safe' },
    });
    expect(handler).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ headers: { application: 'safe' } }),
    );
    await broker.disconnect();
  });
  it('keeps an unroutable outbox row pending and then fails it at the relay budget', async () => {
    const client = new FakeAmqpConnection({ returnMandatory: true });
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    const h = await outboxHarness({
      options: {
        relay: {
          publishTimeoutMs: 10,
          storeTimeoutMs: 10,
          claimLeaseMs: 100,
          maxClockSkewMs: 5,
          maxAttempts: 2,
          baseBackoffMs: 10,
        },
      },
    });
    let failure: unknown;
    h.broker.behaviour = async (call) => {
      try {
        await broker.publish(call.topic, call.message, call.options);
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    try {
      const id = await h.write({ n: 1 });
      await h.sweep();
      expect(failure).toBeInstanceOf(UnroutableMessageError);
      expect(await row(h.db, id)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(h.store.count('markSent')).toBe(0);
      h.clock.advanceWall(10);
      await h.sweep();
      expect(await row(h.db, id)).toMatchObject({ status: 'failed', attempts: 2 });
    } finally {
      await broker.disconnect();
    }
  });
  it('reports false without confirms, and undefined through facades for other brokers', async () => {
    const rabbit = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeAmqpConnection({ withoutConfirmChannel: true }),
    });
    await rabbit.connect();
    expect(rabbit[ROUTED_PUBLISH_AVAILABLE]).toBe(false);
    await rabbit.disconnect();
    const memory = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    expect(
      new TracedBroker(memory, recordingTelemetry(), 'memory')[ROUTED_PUBLISH_AVAILABLE],
    ).toBeUndefined();
    expect(new PipelinedBroker(memory, [])[ROUTED_PUBLISH_AVAILABLE]).toBeUndefined();
  });
});

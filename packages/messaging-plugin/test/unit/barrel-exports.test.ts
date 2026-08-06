import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as messaging from '../../src/index.ts';
import type {
  PubSubMessagingOptions,
  PubSubOptions,
  ServiceBusMessagingOptions,
  ServiceBusOptions,
} from '../../src/index.ts';

/**
 * Barrel exports test.
 *
 * Verifies that all expected value exports are present.
 * Types are verified by the type checker (deno check).
 */
describe('barrel exports', () => {
  it('value exports', () => {
    // Plugin factories
    expect(messaging.MessagingPlugin).toBeDefined();
    expect(typeof messaging.MessagingPlugin).toBe('function');

    expect(messaging.EventsMessagingBridge).toBeDefined();
    expect(typeof messaging.EventsMessagingBridge).toBe('function');

    // Broker implementations
    expect(messaging.InMemoryBroker).toBeDefined();
    expect(typeof messaging.InMemoryBroker).toBe('function');

    expect(messaging.RedisStreamsBroker).toBeDefined();
    expect(typeof messaging.RedisStreamsBroker).toBe('function');

    expect(messaging.RabbitMqBroker).toBeDefined();
    expect(typeof messaging.RabbitMqBroker).toBe('function');

    expect(messaging.NatsBroker).toBeDefined();
    expect(typeof messaging.NatsBroker).toBe('function');

    expect(messaging.KafkaBroker).toBeDefined();
    expect(typeof messaging.KafkaBroker).toBe('function');

    // Serializer
    expect(messaging.JsonSerializer).toBeDefined();
    expect(typeof messaging.JsonSerializer).toBe('function');

    // Request-reply error classes
    expect(messaging.RequestTimeoutError).toBeDefined();
    expect(typeof messaging.RequestTimeoutError).toBe('function');

    expect(messaging.RemoteHandlerError).toBeDefined();
    expect(typeof messaging.RemoteHandlerError).toBe('function');

    expect(messaging.MessagingNotSupportedError).toBeDefined();
    expect(typeof messaging.MessagingNotSupportedError).toBe('function');
  });

  it('type exports', () => {
    // These types are exported from the barrel and compile correctly.
    // Assigning to _ prevents unused-variable warnings while proving
    // the types are part of the module's exported surface.
    const _pubSubOpts: PubSubOptions = {};
    const _serviceBusOpts: ServiceBusOptions = {};
    const _pubSubMessagingOpts: PubSubMessagingOptions = { broker: 'pubsub', projectId: 'test' };
    const _serviceBusMessagingOpts: ServiceBusMessagingOptions = {
      broker: 'service-bus',
      connectionString: 'test',
    };
    expect(_pubSubOpts).toBeDefined();
    expect(_serviceBusOpts).toBeDefined();
    expect(_pubSubMessagingOpts).toBeDefined();
    expect(_serviceBusMessagingOpts).toBeDefined();
  });
});

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

  it('keeps the M75 tracing seam INTERNAL', () => {
    // M75 adds `TracedBroker` and the `*WithHeaders` members on the internal
    // `MessageBrokerAdapter`. None is public API: the decorator is an
    // implementation detail of the plugin, and the seam members are declared on
    // a type the barrel does not export. A leak here would commit the framework
    // to supporting them (§10.1: anything exported from index.ts is public).
    const surface = messaging as unknown as Record<string, unknown>;
    expect(surface.TracedBroker).toBeUndefined();
    expect(surface.MessageBrokerAdapter).toBeUndefined();
  });

  it('exports INatsHeaders, which the public headersFactory option names', () => {
    // `NatsOptions.headersFactory` returns this type, so a consumer supplying
    // the option cannot name its own return type without it (the M52c
    // `NormalizedQuery` lesson — an exported option referencing an unexported
    // type is unnameable).
    const factory: () => messaging.INatsHeaders = () => {
      const values = new Map<string, string>();
      return {
        set: (key, value) => values.set(key, value),
        get: (key) => values.get(key),
        keys: () => values.keys(),
      };
    };
    const headers = factory();
    headers.set('traceparent', '00-a');
    expect(headers.get('traceparent')).toBe('00-a');
  });
});

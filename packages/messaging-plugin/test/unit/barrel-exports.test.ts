import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as messaging from '../../src/index.ts';

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

    // Serializer
    expect(messaging.JsonSerializer).toBeDefined();
    expect(typeof messaging.JsonSerializer).toBe('function');
  });

  it('type exports', () => {
    // Type exports are verified by deno check - this test just confirms
    // the module can be imported without errors
    expect(messaging).toBeDefined();
  });
});

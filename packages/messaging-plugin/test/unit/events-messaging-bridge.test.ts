import { expect } from '@std/expect';
import { EventsMessagingBridge } from '../../src/bridge/events-messaging-bridge.ts';

/**
 * EventsMessagingBridge unit tests - factory configuration tests.
 */
Deno.test('EventsMessagingBridge - provides empty array', () => {
  const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

  expect(plugin.provides).toEqual([]);
});

Deno.test('EventsMessagingBridge - optionalDependencies includes events, messaging, logger', () => {
  const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

  expect(plugin.optionalDependencies).toContain('events');
  expect(plugin.optionalDependencies).toContain('messaging');
  expect(plugin.optionalDependencies).toContain('logger');
});

Deno.test('EventsMessagingBridge - name and version', () => {
  const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

  expect(plugin.name).toBe('events-messaging-bridge');
  expect(plugin.version).toBe('0.1.0');
});

import { expect } from '@std/expect';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

/**
 * MessagingPlugin unit tests - factory configuration tests.
 */
Deno.test('MessagingPlugin - default instance has correct name and provides', () => {
  const plugin = MessagingPlugin();

  expect(plugin.name).toBe('messaging-plugin');
  expect(plugin.provides).toEqual([CAPABILITIES.MESSAGING]);
  expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  expect(plugin.optionalDependencies).toContain('logger');
});

Deno.test('MessagingPlugin - named instance has correct name and provides', () => {
  const plugin = MessagingPlugin({ name: 'events' });

  expect(plugin.name).toBe('messaging-plugin.events');
  expect(plugin.provides).toEqual(['messaging.events']);
});

Deno.test('MessagingPlugin - version is set', () => {
  const plugin = MessagingPlugin();

  expect(plugin.version).toBe('0.1.0');
});

/**
 * Tests for SchedulerPlugin factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPlugin } from '@hono-enterprise/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';

describe('SchedulerPlugin', () => {
  it('returns IPlugin with correct shape', () => {
    const plugin: IPlugin = SchedulerPlugin();
    expect(plugin.name).toBe('scheduler-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual(['scheduler']);
    expect(plugin.priority).toBe(100);
  });

  it('throws for non-UTC timezone', () => {
    expect(() => SchedulerPlugin({ timezone: 'America/New_York' })).toThrow(
      'Non-UTC timezones are not supported in this release',
    );
  });

  it('allows UTC timezone', () => {
    const plugin: IPlugin = SchedulerPlugin({ timezone: 'UTC' });
    expect(plugin.name).toBe('scheduler-plugin');
  });

  it('defaults to UTC when timezone omitted', () => {
    const plugin: IPlugin = SchedulerPlugin();
    expect(plugin.name).toBe('scheduler-plugin');
  });
});

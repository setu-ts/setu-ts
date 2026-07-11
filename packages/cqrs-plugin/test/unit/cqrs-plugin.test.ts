/**
 * CQRS plugin tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

describe('CqrsPlugin', () => {
  it('should have correct name', () => {
    const plugin = CqrsPlugin();
    expect(plugin.name).toBe('cqrs-plugin');
  });

  it('should have correct version', () => {
    const plugin = CqrsPlugin();
    expect(plugin.version).toBe('0.1.0');
  });

  it('should provide correct capabilities', () => {
    const plugin = CqrsPlugin();
    expect(plugin.provides).toEqual([
      CAPABILITIES.CQRS,
      CAPABILITIES.COMMAND_BUS,
      CAPABILITIES.QUERY_BUS,
    ]);
  });

  it('should have NORMAL priority', () => {
    const plugin = CqrsPlugin();
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

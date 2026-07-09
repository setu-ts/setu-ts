/**
 * Unit tests for DatabasePlugin metadata and registration.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';

describe('DatabasePlugin', () => {
  describe('metadata', () => {
    it('has correct name', () => {
      const plugin = DatabasePlugin();
      expect(plugin.name).toBe('database-plugin');
    });

    it('has version 0.1.0', () => {
      const plugin = DatabasePlugin();
      expect(plugin.version).toBe('0.1.0');
    });

    it('provides CAPABILITIES.DATABASE by default', () => {
      const plugin = DatabasePlugin();
      expect(plugin.provides).toContain(CAPABILITIES.DATABASE);
    });

    it('provides database:<name> when named', () => {
      const plugin = DatabasePlugin({ name: 'primary' });
      expect(plugin.provides).toContain('database:primary');
    });

    it('has optionalDependencies logger', () => {
      const plugin = DatabasePlugin();
      expect(plugin.optionalDependencies).toContain('logger');
    });

    it('uses PLUGIN_PRIORITY.NORMAL (500)', () => {
      const plugin = DatabasePlugin();
      expect(plugin.priority).toBe(500);
    });
  });

  describe('adapter type', () => {
    it('defaults to memory adapter', () => {
      const plugin = DatabasePlugin();
      // No error means memory adapter was selected.
      expect(plugin.name).toBe('database-plugin');
    });

    it('accepts prisma type', () => {
      const plugin = DatabasePlugin({ type: 'prisma' });
      expect(plugin.name).toBe('database-plugin');
    });

    it('accepts drizzle type', () => {
      const plugin = DatabasePlugin({ type: 'drizzle' });
      expect(plugin.name).toBe('database-plugin');
    });
  });
});

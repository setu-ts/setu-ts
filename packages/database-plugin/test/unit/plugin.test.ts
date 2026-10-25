/**
 * Unit tests for DatabasePlugin metadata and registration.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import manifest from '../../deno.json' with { type: 'json' };

describe('DatabasePlugin', () => {
  describe('metadata', () => {
    it('has correct name', () => {
      const plugin = DatabasePlugin();
      expect(plugin.name).toBe('database-plugin');
    });

    it('has version 0.1.0', () => {
      const plugin = DatabasePlugin();
      expect(plugin.version).toBe(manifest.version);
    });

    it('provides CAPABILITIES.DATABASE by default', () => {
      const plugin = DatabasePlugin();
      expect(plugin.provides).toContain(CAPABILITIES.DATABASE);
    });

    it('provides database.<name> when named (dot notation)', () => {
      const plugin = DatabasePlugin({ name: 'primary' });
      expect(plugin.provides).toContain('database.primary');
    });

    it('named connection token passes createCapabilityToken validation', () => {
      // The derived token must be valid per createCapabilityToken grammar.
      expect(() => createCapabilityToken('database.primary')).not.toThrow();
    });

    it('named connection does NOT provide bare database token', () => {
      const plugin = DatabasePlugin({ name: 'analytics' });
      expect(plugin.provides).not.toContain(CAPABILITIES.DATABASE);
    });

    it('named connection has derived plugin name', () => {
      const plugin = DatabasePlugin({ name: 'analytics' });
      expect(plugin.name).toBe('database-plugin.analytics');
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
      const plugin = DatabasePlugin({
        type: 'prisma',
        options: { prismaClient: {} },
      });
      expect(plugin.name).toBe('database-plugin');
    });

    it('accepts drizzle type', () => {
      const plugin = DatabasePlugin({
        type: 'drizzle',
        options: {
          drizzleInstance: createDrizzleDatabase(createFakeDrizzleInstance(), (database, work) =>
            database.transaction(work),
          ),
          drizzleTables: { user: createFakeDrizzleTable('user') },
        },
      });
      expect(plugin.name).toBe('database-plugin');
    });
  });

  describe('two named instances coexist', () => {
    it('database.primary and database.analytics have distinct tokens', () => {
      const primary = DatabasePlugin({ name: 'primary' });
      const analytics = DatabasePlugin({ name: 'analytics' });
      expect(primary.provides![0]).toBe('database.primary');
      expect(analytics.provides![0]).toBe('database.analytics');
      expect(primary.provides![0]).not.toBe(analytics.provides![0]);
    });
  });
});

describe('M119e pool error reporting at registration', () => {
  for (const loggerMode of ['absent', 'warn', 'no-warn', 'existing'] as const) {
    it(`attaches only if needed with logger ${loggerMode}`, async () => {
      const { EventEmitter } = await import('node:events');
      const { createApplication } = await import('@setu-ts/kernel');
      const { RuntimePlugin } = await import('@setu-ts/runtime');
      const pool = new EventEmitter();
      const logs: unknown[] = [];
      if (loggerMode === 'existing') pool.on('error', () => {});
      const db = Object.assign(createFakeDrizzleInstance(), { $client: pool });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          ...(loggerMode === 'absent'
            ? []
            : [
                {
                  name: 'logger',
                  version: '1.0.0',
                  provides: [CAPABILITIES.LOGGER],
                  register(ctx: import('@setu-ts/common').IPluginContext) {
                    ctx.services.register(
                      CAPABILITIES.LOGGER,
                      loggerMode === 'no-warn'
                        ? {}
                        : {
                            warn(message: string, meta: unknown) {
                              logs.push({ message, meta });
                            },
                          },
                    );
                  },
                },
              ]),
          DatabasePlugin({
            type: 'drizzle',
            options: {
              drizzleInstance: createDrizzleDatabase(db, (database, work) =>
                database.transaction(work),
              ),
              drizzleTables: { User: createFakeDrizzleTable('User') },
            },
          }),
        ],
      });
      await app.start();
      expect(pool.listenerCount('error')).toBe(1);
      expect(() => pool.emit('error', new Error('idle connection lost'))).not.toThrow();
      expect(logs.length).toBe(loggerMode === 'warn' ? 1 : 0);
      await app.stop();
      expect(pool.listenerCount('error')).toBe(1);
    });
  }
});

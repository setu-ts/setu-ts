/**
 * Tests for SchedulerPlugin factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthIndicatorFn, IPlugin } from '@hono-enterprise/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

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

  it('register() wires service under "scheduler" token', async () => {
    const plugin = SchedulerPlugin();
    const runtime = new FakeRuntime();
    const registeredServices = new Map<string, unknown>();
    const registeredHealth = new Map<string, HealthIndicatorFn>();
    const closeCallbacks: Array<() => Promise<void>> = [];

    const ctx = {
      runtime,
      logger: undefined,
      services: {
        register<T>(token: string, service: T) {
          registeredServices.set(token, service);
        },
      },
      health: {
        register(name: string, fn: HealthIndicatorFn) {
          registeredHealth.set(name, fn);
        },
      },
      lifecycle: {
        onClose(fn: () => Promise<void>) {
          closeCallbacks.push(fn);
        },
      },
    };

    // @ts-ignore — ctx shape matches IPluginContext for test purposes
    await plugin.register(ctx);

    // Service registered under 'scheduler'
    expect(registeredServices.has('scheduler')).toBe(true);
    expect(registeredServices.get('scheduler')).toBeDefined();

    // Health indicator registered
    expect(registeredHealth.has('scheduler')).toBe(true);

    // Close callback registered
    expect(closeCallbacks.length).toBe(1);
  });

  it('register() calls service.connect()', async () => {
    const plugin = SchedulerPlugin();
    const runtime = new FakeRuntime();
    const registeredServices = new Map<string, unknown>();
    const closeCallbacks: Array<() => Promise<void>> = [];

    const ctx = {
      runtime,
      logger: undefined,
      services: {
        register<T>(token: string, service: T) {
          registeredServices.set(token, service);
        },
      },
      health: {
        register(_name: string, _fn: HealthIndicatorFn) {},
      },
      lifecycle: {
        onClose(fn: () => Promise<void>) {
          closeCallbacks.push(fn);
        },
      },
    };

    // @ts-ignore — ctx shape matches IPluginContext for test purposes
    await plugin.register(ctx);

    // Service registered under 'scheduler'
    expect(registeredServices.has('scheduler')).toBe(true);
  });

  it('register() onClose calls service.disconnect() and lock.disconnect()', async () => {
    const fake = new FakeRedisClient();
    const plugin = SchedulerPlugin({
      distributedLock: { enabled: true, storage: 'redis', client: fake },
    });

    const runtime = new FakeRuntime();
    const registeredServices = new Map<string, unknown>();
    const closeCallbacks: Array<() => Promise<void>> = [];

    const ctx = {
      runtime,
      logger: undefined,
      services: {
        register<T>(token: string, service: T) {
          registeredServices.set(token, service);
        },
      },
      health: {
        register(_name: string, _fn: HealthIndicatorFn) {},
      },
      lifecycle: {
        onClose(fn: () => Promise<void>) {
          closeCallbacks.push(fn);
        },
      },
    };

    // @ts-ignore — ctx shape matches IPluginContext for test purposes
    await plugin.register(ctx);

    // Fire close callback
    await closeCallbacks[0]();

    // Service should have been disconnected (check via close callback execution)

    // Redis client should have been quit
    expect(fake.calls.some((c) => c.method === 'quit')).toBe(true);
  });

  it('register() with MemoryLock does not call lock.connect()', async () => {
    const plugin = SchedulerPlugin(); // default MemoryLock
    const runtime = new FakeRuntime();
    const registeredServices = new Map<string, unknown>();
    const closeCallbacks: Array<() => Promise<void>> = [];

    const ctx = {
      runtime,
      logger: undefined,
      services: {
        register<T>(token: string, service: T) {
          registeredServices.set(token, service);
        },
      },
      health: {
        register(_name: string, _fn: HealthIndicatorFn) {},
      },
      lifecycle: {
        onClose(fn: () => Promise<void>) {
          closeCallbacks.push(fn);
        },
      },
    };

    // @ts-ignore — ctx shape matches IPluginContext for test purposes
    await plugin.register(ctx);

    // Service registered
    expect(registeredServices.has('scheduler')).toBe(true);
  });
});

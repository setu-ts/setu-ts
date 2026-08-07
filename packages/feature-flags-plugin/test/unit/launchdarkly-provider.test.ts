/**
 * Tests for `LaunchDarklyProvider` — the synchronous/asynchronous bridge.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  LaunchDarklyProvider,
  toLaunchDarklyContext,
} from '../../src/providers/launchdarkly-provider.ts';
import { LaunchDarklyModuleError } from '../../src/providers/launchdarkly-module.ts';
import type { ILogger } from '@setu-ts/common';
import { FakeLaunchDarklyClient, FakeLaunchDarklyModule } from '../fixtures/fake-launchdarkly.ts';

/** Lets pending background refills settle before asserting on the cache. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('toLaunchDarklyContext', () => {
  it('maps a userId to a keyed user context', () => {
    expect(toLaunchDarklyContext({ userId: 'u1' })).toEqual({ kind: 'user', key: 'u1' });
  });

  it('produces an anonymous context when no userId is supplied', () => {
    expect(toLaunchDarklyContext()).toEqual({
      kind: 'user',
      key: '__anonymous__',
      anonymous: true,
    });
    expect(toLaunchDarklyContext({})).toEqual({
      kind: 'user',
      key: '__anonymous__',
      anonymous: true,
    });
  });

  it('carries targeting attributes through so LaunchDarkly rules can read them', () => {
    expect(toLaunchDarklyContext({ userId: 'u1', attributes: { plan: 'pro', seats: 5 } })).toEqual({
      kind: 'user',
      key: 'u1',
      plan: 'pro',
      seats: 5,
    });
  });
});

describe('LaunchDarklyProvider', () => {
  it('reports its own provider type', () => {
    const provider = new LaunchDarklyProvider({ client: new FakeLaunchDarklyClient() });
    expect(provider.type).toBe('launchdarkly');
  });

  it('builds a client from an injected module and forwards sdkKey and ldOptions', async () => {
    const client = new FakeLaunchDarklyClient();
    const module = new FakeLaunchDarklyModule(client);
    const provider = new LaunchDarklyProvider({
      sdkKey: 'sdk-key-1',
      module,
      ldOptions: { stream: false },
    });

    await provider.start();

    expect(module.initCalls).toEqual([{ sdkKey: 'sdk-key-1', options: { stream: false } }]);
    await provider.stop();
  });

  it('throws when neither a client nor an sdkKey is configured', async () => {
    const provider = new LaunchDarklyProvider({
      module: new FakeLaunchDarklyModule(new FakeLaunchDarklyClient()),
    });
    await expect(provider.start()).rejects.toThrow('requires options.sdkKey');
  });

  it('throws when the sdkKey is empty', async () => {
    const provider = new LaunchDarklyProvider({
      sdkKey: '',
      module: new FakeLaunchDarklyModule(new FakeLaunchDarklyClient()),
    });
    await expect(provider.start()).rejects.toThrow('requires options.sdkKey');
  });

  it('surfaces a module adaptation failure', async () => {
    const provider = new LaunchDarklyProvider({ sdkKey: 'k', module: { nope: true } });
    await expect(provider.start()).rejects.toThrow(LaunchDarklyModuleError);
  });

  it('prewarms the anonymous snapshot during start', async () => {
    const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
    const provider = new LaunchDarklyProvider({ client });

    await provider.start();

    expect(client.snapshotCalls).toEqual(['__anonymous__']);
    // Prewarmed, so this is a real LaunchDarkly answer rather than the fallback.
    expect(provider.isEnabled('beta')).toBe(true);
    await provider.stop();
  });

  it('returns the fallback for a cold context and refills in the background', async () => {
    const client = new FakeLaunchDarklyClient({ values: { u1: { beta: true } } });
    const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
    await provider.start();

    // First read for u1: no snapshot yet, so the configured fallback is served.
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(false);

    await flush();

    // Second read: answered from the real snapshot the background refill loaded.
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);
    await provider.stop();
  });

  it('honors a non-default fallbackValue on a cold context', async () => {
    const client = new FakeLaunchDarklyClient({ values: { u1: { beta: false } } });
    const provider = new LaunchDarklyProvider({ client, fallbackValue: true });
    await provider.start();

    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);
    await flush();
    // Once the snapshot lands the real value wins over the fallback.
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(false);
    await provider.stop();
  });

  it('coalesces concurrent refills for the same context into one SDK call', async () => {
    const client = new FakeLaunchDarklyClient({ values: { u1: { beta: true } } });
    const provider = new LaunchDarklyProvider({ client });
    await provider.start();

    // A hot loop over an uncached user must not launch one SDK call per read.
    provider.isEnabled('beta', { userId: 'u1' });
    provider.isEnabled('beta', { userId: 'u1' });
    provider.isEnabled('other', { userId: 'u1' });
    await flush();

    const u1Calls = client.snapshotCalls.filter((key) => key === 'u1');
    expect(u1Calls.length).toBe(1);
    await provider.stop();
  });

  it('treats an unknown flag as off', async () => {
    const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
    const provider = new LaunchDarklyProvider({ client });
    await provider.start();
    expect(provider.isEnabled('never-defined')).toBe(false);
    await provider.stop();
  });

  it('treats a non-boolean variation as off', async () => {
    const client = new FakeLaunchDarklyClient({
      values: { __anonymous__: { theme: 'dark', limit: 5 } },
    });
    const provider = new LaunchDarklyProvider({ client });
    await provider.start();
    expect(provider.isEnabled('theme')).toBe(false);
    expect(provider.isEnabled('limit')).toBe(false);
    await provider.stop();
  });

  it('clears every cached snapshot when the SDK reports a flag update', async () => {
    const client = new FakeLaunchDarklyClient({ values: { u1: { beta: true } } });
    const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
    await provider.start();

    provider.isEnabled('beta', { userId: 'u1' });
    await flush();
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);

    client.emitUpdate();

    // Cache dropped: back to a cold read that serves the fallback and refills.
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(false);
    await flush();
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);
    await provider.stop();
  });

  it('does not cache an invalid snapshot', async () => {
    const client = new FakeLaunchDarklyClient({
      invalidSnapshot: true,
      values: { u1: { beta: true } },
    });
    const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
    await provider.start();

    provider.isEnabled('beta', { userId: 'u1' });
    await flush();
    // An invalid snapshot would pin every flag to null; it must not be stored.
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(false);
    await provider.stop();
  });

  it('survives a failing snapshot fetch and keeps serving the fallback', async () => {
    const client = new FakeLaunchDarklyClient({ failSnapshot: true });
    const provider = new LaunchDarklyProvider({ client, fallbackValue: true });
    await provider.start();
    await flush();
    expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);
    await provider.stop();
  });

  it('logs a refill failure through the injected logger', async () => {
    const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      level: 'info',
      fatal: (): void => {},
      error: (): void => {},
      warn: (message: string, metadata?: Record<string, unknown>): void => {
        warnings.push(metadata === undefined ? { message } : { message, metadata });
      },
      info: (): void => {},
      debug: (): void => {},
      trace: (): void => {},
      child: (): ILogger => logger,
    };
    const client = new FakeLaunchDarklyClient({ failSnapshot: true });
    const provider = new LaunchDarklyProvider({ client }, logger);

    await provider.start();
    await flush();

    const failure = warnings.find((w) => w.message.includes('snapshot refresh failed'));
    expect(failure).toBeDefined();
    expect(failure?.metadata?.error).toBe('snapshot unavailable');
    await provider.stop();
  });

  it('logs an initialization timeout through the injected logger', async () => {
    const warnings: string[] = [];
    const logger: ILogger = {
      level: 'info',
      fatal: (): void => {},
      error: (): void => {},
      warn: (message: string): void => {
        warnings.push(message);
      },
      info: (): void => {},
      debug: (): void => {},
      trace: (): void => {},
      child: (): ILogger => logger,
    };
    const client = new FakeLaunchDarklyClient({ failInitialization: true });
    const provider = new LaunchDarklyProvider({ client }, logger);

    await provider.start();

    expect(warnings.some((m) => m.includes('did not initialize'))).toBe(true);
    await provider.stop();
  });

  describe('isEnabledAsync', () => {
    it('awaits boolVariation and is correct on a cold context', async () => {
      const client = new FakeLaunchDarklyClient({ values: { u1: { beta: true } } });
      const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
      await provider.start();

      // No warm-up: the async path has no cold-context caveat.
      expect(await provider.isEnabledAsync('beta', { userId: 'u1' })).toBe(true);
      expect(client.variations).toEqual([
        { key: 'beta', contextKey: 'u1', defaultValue: false },
      ]);
      await provider.stop();
    });

    it('passes the configured fallbackValue as the SDK default', async () => {
      const client = new FakeLaunchDarklyClient();
      const provider = new LaunchDarklyProvider({ client, fallbackValue: true });
      await provider.start();

      expect(await provider.isEnabledAsync('unknown', { userId: 'u2' })).toBe(true);
      expect(client.variations[0]?.defaultValue).toBe(true);
      await provider.stop();
    });

    it('warms the synchronous path for the same context', async () => {
      const client = new FakeLaunchDarklyClient({ values: { u1: { beta: true } } });
      const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
      await provider.start();

      await provider.isEnabledAsync('beta', { userId: 'u1' });
      await flush();

      expect(provider.isEnabled('beta', { userId: 'u1' })).toBe(true);
      await provider.stop();
    });

    it('returns the fallback when the provider was never started', async () => {
      const provider = new LaunchDarklyProvider({
        client: new FakeLaunchDarklyClient(),
        fallbackValue: true,
      });
      expect(await provider.isEnabledAsync('beta')).toBe(true);
    });
  });

  describe('lifecycle and status', () => {
    it('reports unhealthy before start', () => {
      const provider = new LaunchDarklyProvider({ client: new FakeLaunchDarklyClient() });
      expect(provider.status()).toEqual({
        healthy: false,
        detail: 'launchdarkly client not started',
      });
    });

    it('reports healthy once the client is initialized', async () => {
      const provider = new LaunchDarklyProvider({ client: new FakeLaunchDarklyClient() });
      await provider.start();
      expect(provider.status()).toEqual({ healthy: true });
      await provider.stop();
    });

    it('tolerates an initialization timeout and reports it through status', async () => {
      const client = new FakeLaunchDarklyClient({
        failInitialization: true,
        neverInitializes: true,
      });
      const provider = new LaunchDarklyProvider({ client });

      // A briefly unreachable flag backend must not refuse application startup.
      await provider.start();

      const status = provider.status();
      expect(status.healthy).toBe(false);
      expect(status.detail).toContain('initialization timed out');
      await provider.stop();
    });

    it('reports a generic detail when the client simply has not connected yet', async () => {
      const client = new FakeLaunchDarklyClient({ neverInitializes: true });
      const provider = new LaunchDarklyProvider({ client });
      await provider.start();
      expect(provider.status().detail).toContain('has not completed initialization');
      await provider.stop();
    });

    it('is idempotent on start and closes the client on stop', async () => {
      const client = new FakeLaunchDarklyClient();
      const module = new FakeLaunchDarklyModule(client);
      const provider = new LaunchDarklyProvider({ sdkKey: 'k', module });

      await provider.start();
      await provider.start();
      expect(module.initCalls.length).toBe(1);

      await provider.stop();
      expect(client.closeCount).toBe(1);
      expect(provider.status().healthy).toBe(false);
    });

    it('drops cached snapshots on stop', async () => {
      const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
      const provider = new LaunchDarklyProvider({ client, fallbackValue: false });
      await provider.start();
      expect(provider.isEnabled('beta')).toBe(true);

      await provider.stop();
      // No client and no cache: the fallback is all that remains.
      expect(provider.isEnabled('beta')).toBe(false);
    });
  });
});

describe('LaunchDarklyProvider start() rollback', () => {
  it('does not mark itself started when the client cannot be built', async () => {
    const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
    const module = new FakeLaunchDarklyModule(client);
    // First attempt fails: no sdkKey and no injected client.
    const provider = new LaunchDarklyProvider({ module });
    await expect(provider.start()).rejects.toThrow('requires options.sdkKey');

    // A retry must actually retry rather than resolve silently and leave every
    // evaluation stuck on the fallback forever.
    const fixed = new LaunchDarklyProvider({ sdkKey: 'k', module });
    await fixed.start();
    expect(fixed.status().healthy).toBe(true);
    expect(fixed.isEnabled('beta')).toBe(true);
    await fixed.stop();
  });

  it('a second start() after a failure still builds the client', async () => {
    const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
    let failNext = true;
    const provider = new LaunchDarklyProvider({
      sdkKey: 'k',
      module: {
        init: (): typeof client => {
          if (failNext) {
            failNext = false;
            throw new Error('transient SDK failure');
          }
          return client;
        },
      },
    });

    await expect(provider.start()).rejects.toThrow('transient SDK failure');
    // Previously this resolved with no client and wedged the provider.
    await provider.start();
    expect(provider.status().healthy).toBe(true);
    expect(provider.isEnabled('beta')).toBe(true);
    await provider.stop();
  });
});

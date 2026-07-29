/**
 * Tests for `FeatureFlagService` — delegates to a `FlagProvider`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FeatureFlagService } from '../../src/services/feature-flags-service.ts';
import type { FlagProvider } from '../../src/interfaces/index.ts';

describe('FeatureFlagService', () => {
  it('isEnabled delegates to the provider', () => {
    let capturedFlag = '';
    let capturedContext: object | undefined;
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: (flag: string, context?: object): boolean => {
        capturedFlag = flag;
        capturedContext = context;
        return true;
      },
      start: (): Promise<void> => {
        return Promise.resolve();
      },
      stop: (): Promise<void> => {
        return Promise.resolve();
      },
    };

    const service = new FeatureFlagService(fakeProvider);
    service.isEnabled('my-flag', { userId: 'u1' });

    expect(capturedFlag).toBe('my-flag');
    expect(capturedContext).toEqual({ userId: 'u1' });
  });

  it('await service.start() calls provider.start()', async () => {
    let started = false;
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: (): Promise<void> => {
        started = true;
        return Promise.resolve();
      },
      stop: (): Promise<void> => Promise.resolve(),
    };

    const service = new FeatureFlagService(fakeProvider);
    await service.start();
    expect(started).toBe(true);
  });

  it('await service.stop() calls provider.stop()', async () => {
    let stopped = false;
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => {
        stopped = true;
        return Promise.resolve();
      },
    };

    const service = new FeatureFlagService(fakeProvider);
    await service.stop();
    expect(stopped).toBe(true);
  });

  it('status() forwards the provider status when present', () => {
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      status: (): { healthy: boolean } => ({ healthy: true }),
    };

    const service = new FeatureFlagService(fakeProvider);
    expect(service.status()).toEqual({ healthy: true });
  });

  it('status() returns undefined when provider has no status()', () => {
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
    };

    const service = new FeatureFlagService(fakeProvider);
    expect(service.status()).toBeUndefined();
  });
});

describe('FeatureFlagService.isEnabledAsync', () => {
  /** A provider with no async path — the config/memory/database shape. */
  function syncOnlyProvider(value: boolean, seen: string[]): FlagProvider {
    return {
      type: 'memory',
      isEnabled: (flag) => {
        seen.push(flag);
        return value;
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  }

  it('falls back to the synchronous evaluation when the provider has no async path', async () => {
    const seen: string[] = [];
    const service = new FeatureFlagService(syncOnlyProvider(true, seen));
    expect(await service.isEnabledAsync('beta')).toBe(true);
    expect(seen).toEqual(['beta']);
  });

  it('forwards the targeting context on the fallback path', async () => {
    let received: unknown;
    const service = new FeatureFlagService({
      type: 'memory',
      isEnabled: (_flag, context) => {
        received = context;
        return false;
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    await service.isEnabledAsync('beta', { userId: 'u1' });
    expect(received).toEqual({ userId: 'u1' });
  });

  it('delegates to the provider implementation when one exists', async () => {
    const calls: Array<{ flag: string; userId: string | undefined }> = [];
    const service = new FeatureFlagService({
      type: 'launchdarkly',
      // The sync path deliberately disagrees, so a test that accidentally
      // routed through it would fail rather than pass silently.
      isEnabled: () => false,
      isEnabledAsync: (flag, context) => {
        calls.push({ flag, userId: context?.userId });
        return Promise.resolve(true);
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });

    expect(await service.isEnabledAsync('beta', { userId: 'u1' })).toBe(true);
    expect(calls).toEqual([{ flag: 'beta', userId: 'u1' }]);
    expect(service.isEnabled('beta', { userId: 'u1' })).toBe(false);
  });

  it('invokes the provider method with the provider as `this`', async () => {
    // A delegation written as `asyncEval(flag, context)` rather than
    // `asyncEval.call(provider, ...)` would lose `this` and break any provider
    // reading its own private state — which the LaunchDarkly one does.
    class StatefulProvider implements FlagProvider {
      readonly type = 'launchdarkly' as const;
      readonly #answer = true;
      isEnabled(): boolean {
        return false;
      }
      isEnabledAsync(): Promise<boolean> {
        return Promise.resolve(this.#answer);
      }
      start(): Promise<void> {
        return Promise.resolve();
      }
      stop(): Promise<void> {
        return Promise.resolve();
      }
    }
    const service = new FeatureFlagService(new StatefulProvider());
    expect(await service.isEnabledAsync('beta')).toBe(true);
  });

  it('routes both entry points through one provider under a non-default config', async () => {
    // The mandated both-entry-points test: one provider configured away from
    // its defaults must produce identical output through the sync and async
    // surfaces, so neither can drift into its own hardcoded behavior.
    const NON_DEFAULT_ANSWER = true;
    let syncCalls = 0;
    const provider: FlagProvider = {
      type: 'custom',
      isEnabled: () => {
        syncCalls++;
        return NON_DEFAULT_ANSWER;
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    const service = new FeatureFlagService(provider);

    const sync = service.isEnabled('beta', { userId: 'u1' });
    const async = await service.isEnabledAsync('beta', { userId: 'u1' });

    expect(sync).toBe(NON_DEFAULT_ANSWER);
    expect(async).toBe(sync);
    // Two reads, one provider: the async surface routed through the same
    // synchronous evaluation rather than a second, divergent implementation.
    expect(syncCalls).toBe(2);
  });
});

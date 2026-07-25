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

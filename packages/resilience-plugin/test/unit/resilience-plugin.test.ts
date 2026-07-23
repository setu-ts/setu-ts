import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPlugin, IResilienceService } from '@hono-enterprise/common';
import { ResiliencePlugin } from '../../src/plugin/resilience-plugin.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

describe('ResiliencePlugin', () => {
  it('returns an IPlugin with the correct shape', () => {
    const plugin: IPlugin = ResiliencePlugin();
    expect(plugin.name).toBe('resilience-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual(['resilience']);
    expect(plugin.priority).toBe(500);
  });

  it('register() registers an IResilienceService under the resilience token', () => {
    const plugin = ResiliencePlugin();
    const { ctx, registeredServices } = createFakeContext();
    plugin.register(ctx);

    expect(registeredServices.has('resilience')).toBe(true);
    const service = registeredServices.get('resilience') as IResilienceService;
    expect(typeof service.wrap).toBe('function');
  });

  it('registers no health indicator and no onClose hook', () => {
    const plugin = ResiliencePlugin();
    const { ctx, registeredHealth, closeCallbacks } = createFakeContext();
    plugin.register(ctx);

    expect(registeredHealth.size).toBe(0);
    expect(closeCallbacks.length).toBe(0);
  });

  it('passes default policies through to the registered service', async () => {
    const plugin = ResiliencePlugin({
      defaultRetry: { limit: 2, delay: 5, backoff: 'fixed' },
    });
    const { ctx, registeredServices } = createFakeContext();
    plugin.register(ctx);

    const service = registeredServices.get('resilience') as IResilienceService;
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return calls < 2 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
    }, { retry: true });
    expect(await guarded()).toBe('ok');
    expect(calls).toBe(2);
  });
});

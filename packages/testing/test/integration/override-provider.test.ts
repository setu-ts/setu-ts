import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer, IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { DiPlugin } from '@setu-ts/di-plugin';
import { Controller, DecoratorPlugin, Get, Inject, Injectable } from '@setu-ts/decorator-plugin';
import { createTestApp } from '../../src/test-app.ts';
import { overrideProvider } from '../../src/override-provider.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

@Injectable({ token: 'pricing-service' })
class PricingService {
  price(): number {
    return 100;
  }
}

@Controller('/price')
@Inject('pricing-service')
class PriceController {
  constructor(private readonly pricing: { price(): number }) {}

  @Get()
  get() {
    return { price: this.pricing.price() };
  }
}

function createApp() {
  return createApplication({
    plugins: [
      runtimePlugin(),
      DiPlugin(),
      DecoratorPlugin({ controllers: [PriceController], services: [PricingService] }),
    ],
  });
}

describe('overrideProvider with DiPlugin and DecoratorPlugin', () => {
  it('serves the real provider without an override (the control)', async () => {
    const app = await createTestApp({ app: createApp() });
    try {
      const response = await app.inject({ method: 'GET', url: '/price' });
      expect(response.json()).toEqual({ price: 100 });
    } finally {
      await app.stop();
    }
  });

  it('constructs the decorated controller with the double', async () => {
    const app = await createTestApp({
      app: createApp(),
      overrides: [overrideProvider('pricing-service', { useValue: { price: () => 0 } })],
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/price' });
      expect(response.json()).toEqual({ price: 0 });
    } finally {
      await app.stop();
    }
  });

  it('keeps the double in a child scope that registers the real provider', async () => {
    const app = await createTestApp({
      app: createApp(),
      overrides: [overrideProvider('pricing-service', { useValue: { price: () => 0 } })],
    });
    try {
      const scope = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).createScope();
      scope.register('pricing-service', { useClass: PricingService }, { scope: 'transient' });
      expect(scope.resolve<{ price(): number }>('pricing-service').price()).toBe(0);
      // A scope of that scope is wrapped the same way.
      const nested = scope.createScope();
      nested.register('pricing-service', { useClass: PricingService }, { scope: 'transient' });
      expect(nested.resolve<{ price(): number }>('pricing-service').price()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('refuses a mistyped token rather than testing the real provider', async () => {
    await expect(createTestApp({
      app: createApp(),
      overrides: [overrideProvider('pricing-servce', { useValue: { price: () => 0 } })],
    })).rejects.toThrow(/nothing in the application registers or injects/);
  });
});

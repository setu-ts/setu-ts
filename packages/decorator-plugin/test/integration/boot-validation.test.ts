import { expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ContainerValidationError, DiPlugin } from '@setu-ts/di-plugin';
import { Controller, Get, Inject, DecoratorPlugin } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

it('M131b 3.8 reports controller and unrelated wiring failures exactly once at boot', async () => {
  metadataStore.clear();
  @Controller('/broken')
  @Inject('controller-missing')
  class BrokenController {
    @Get('/')
    get(): string {
      return 'unreachable';
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      {
        name: 'bad-provider',
        version: '1.0.0',
        dependencies: ['di-plugin'],
        register(ctx) {
          ctx.container!.register('unrelated', {
            useFactory: () => ({}),
            inject: ['factory-missing'],
          });
        },
      },
      DecoratorPlugin({ controllers: [BrokenController] }),
    ],
  });
  try {
    await app.start();
    throw new Error('expected invalid graph');
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerValidationError);
    expect(
      (error as ContainerValidationError).findings.map((finding) => finding.token).sort(),
    ).toEqual(['controller-missing', 'factory-missing']);
  } finally {
    await app.stop();
    metadataStore.clear();
  }
});

it('M131b 3.8 lazily resolves a deferred controller after later registration repairs the graph', async () => {
  metadataStore.clear();
  let constructions = 0;
  @Controller('/repaired')
  @Inject('late-value')
  class RepairedController {
    constructor(readonly value: string) {
      constructions++;
      this.get = () => `${this.value}-bound`;
    }
    @Get('/')
    get(): string {
      return this.value;
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      DecoratorPlugin({ controllers: [RepairedController] }),
      {
        name: 'late-provider',
        version: '1.0.0',
        dependencies: ['decorator-plugin'],
        register(ctx) {
          ctx.container!.register('late-value', { useValue: 'repaired' });
        },
      },
    ],
  });
  await app.start();
  try {
    expect(constructions).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/repaired' })).json()).toBe('repaired-bound');
    expect((await app.inject({ method: 'GET', url: '/repaired' })).json()).toBe('repaired-bound');
    expect(constructions).toBe(1);
  } finally {
    await app.stop();
    metadataStore.clear();
  }
});

it('M131b 3.8 includes an invalid controller registered by an earlier plugin', async () => {
  metadataStore.clear();
  @Controller('/registered')
  @Inject('controller-missing')
  class RegisteredController {
    @Get('/')
    get(): string {
      return 'unreachable';
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      {
        name: 'pre-registration',
        version: '1.0.0',
        dependencies: ['di-plugin'],
        register(ctx) {
          const provider = { useClass: RegisteredController, inject: ['controller-missing'] };
          ctx.container!.register('RegisteredController', provider);
          ctx.container!.register(RegisteredController, provider);
          ctx.container!.register('unrelated', {
            useFactory: () => ({}),
            inject: ['factory-missing'],
          });
        },
      },
      DecoratorPlugin({ controllers: [RegisteredController] }),
    ],
  });
  try {
    await app.start();
    throw new Error('expected invalid graph');
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerValidationError);
    expect(
      (error as ContainerValidationError).findings.map((finding) => finding.token).sort(),
    ).toEqual(['controller-missing', 'factory-missing']);
  } finally {
    await app.stop();
    metadataStore.clear();
  }
});
